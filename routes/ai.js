import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import OpenAI from 'openai';
import { config } from '../config.js';
import { dbRun, dbAll, dbGet } from '../db.js';
import { upload } from '../middleware/upload.js';
import { Whisper } from '../middleware/whisper.js';
import fs from "fs/promises";
import path from 'path';
export const aiRouter = express.Router();

const openai = new OpenAI({
  apiKey: config.openaiApiKey,
  baseURL: config.openaiBaseUrl
});

// ==================== 工具函数 ====================

function getLocalTimeString() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mi = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

// 会话操作
function createSession(openid, title = '新会话') {
  const now = getLocalTimeString();
  return dbRun(
    `INSERT INTO sessions (openid, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    [openid, title, now, now]
  ).then(result => result.lastID);
}

// 消息操作
function insertMessage(sessionId, role, content, reasoning_content = null) {
  const now = getLocalTimeString();
  return dbRun(
    `INSERT INTO chat_records(session_id, role, content, reasoning_content, created_at) VALUES (?, ?, ?, ?, ?)`,
    [sessionId, role, content, reasoning_content, now]
  );
}

function updateMessage(messageId, content, reasoning_content = null) {
  const now = getLocalTimeString();
  return dbRun(
    `UPDATE chat_records SET content = ?, reasoning_content = ?, created_at = ? WHERE id = ?`,
    [content, reasoning_content, now, messageId]
  );
}

function getSessionHistory(sessionId, beforeTime = null) {
  if (beforeTime) {
    return dbAll(
      `SELECT role, content FROM chat_records 
       WHERE session_id = ? AND created_at < ?
       ORDER BY created_at ASC`,
      [sessionId, beforeTime]
    );
  }
  return dbAll(
    `SELECT role, content FROM chat_records WHERE session_id = ? ORDER BY created_at ASC`,
    [sessionId]
  );
}

// SSE 响应设置
function setupSSEResponse(res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
}

// 调用 AI 模型（支持流式和非流式）
async function callAI(messages, stream = false, models = 'deepseek-chat') {
  const completion = await openai.chat.completions.create(
    {
      model: models,
      messages,
      stream,
    },
    stream ? { responseType: 'stream' } : {}
  );
  return completion;
}

// 智能缓冲：合并小片段再 emit，减少前端收到的碎片化文本
// emitFn 接受一个合并后的字符串
async function handleBufferedStreamResponse(completion, emitFn, options = {}) {
  const minChars = options.minChars || 40; // 达到最小长度就发送
  const maxWait = options.maxWait || 200; // 毫秒，超过该时间也会发送（防止长时间等待）
  const boundaryRegex = options.boundaryRegex || /\n\n|[。！？.!?]\s*$/; // 遇到段落或句尾则发送
  const emitThinking = options.emitThinking !== false; // 是否将思考链作为独立事件发出，默认 true

  let buffer = '';
  let lastEmit = Date.now();
  let full = '';
  try {
    for await (const event of completion) {
      const delta = event.choices?.[0]?.delta || {};

      // 处理常规文本片段
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        buffer += delta.content;
        full += delta.content;
      }

      // 如果返回了思考链（deepseek 风格，字段名为 reasoning_content），优先将当前 buffer 刷出，再发送 thinking 事件
      if (emitThinking && delta.reasoning_content) {
        if (buffer.length > 0) {
          await emitFn({ type: 'delta', text: buffer });
          buffer = '';
          lastEmit = Date.now();
        }

        // 直接发送 thinking 对象
        try {
          await emitFn({ type: 'thinking', thinking: delta.reasoning_content });
        } catch (e) {
          console.error('发送 thinking 事件失败:', e);
        }
      }

      // 决定是否按语义边界或长度或时间发送当前 buffer
      const now = Date.now();
      const shouldByLength = buffer.length >= minChars;
      const shouldByBoundary = boundaryRegex.test(buffer);
      const shouldByTime = (now - lastEmit) >= maxWait && buffer.length > 0;

      if (shouldByBoundary || shouldByLength || shouldByTime) {
        await emitFn({ type: 'delta', text: buffer });
        buffer = '';
        lastEmit = Date.now();
      }
    }
  } catch (err) {
    console.error('缓冲流式响应处理异常:', err);
  }

  // 流结束前将剩余 buffer 发出
  if (buffer.length > 0) {
    await emitFn({ type: 'delta', text: buffer });
  }
  return full;
}

// ==================== 路由处理 ====================

// 聊天接口
aiRouter.post('/chat', authMiddleware, async (req, res) => {
  const { messages, model, stream, sessionId: clientSessionId } = req.body;
  const openid = req.user.openid;

  if (!messages || !Array.isArray(messages) || !messages.every(msg => msg.role && msg.content && typeof msg.content === 'string')) {
    return res.status(400).json({ msg: 'messages格式不正确' });
  }

  try {
    // 获取或创建会话
    let sessionId = clientSessionId;
    if (!sessionId) {
      sessionId = await createSession(openid, messages[0].content);
    }
    // 获取会话历史
    const historyMessages = await getSessionHistory(sessionId);
    const allMessages = historyMessages.concat(messages);

    // 保存用户消息
    for (const msg of messages) {
      await insertMessage(sessionId, msg.role, msg.content);
    }

    if (stream) {
      setupSSEResponse(res);
      let isClientConnected = true;
      req.on('close', () => {
        isClientConnected = false;
      });

      // 调用 AI 并流式返回
      let lastReasoningContent = '';
      const completion = await callAI(allMessages, true, model);
      const assistantContent = await handleBufferedStreamResponse(completion, async (evt) => {
        if (!isClientConnected) return;
        if (evt && evt.type === 'delta') {
          res.write(`data: ${JSON.stringify(evt)}\n\n`);
        } else if (evt && evt.type === 'thinking') {
          lastReasoningContent += evt.thinking;
          res.write(`data: ${JSON.stringify({ type: 'thinking', thinking: evt.thinking })}\n\n`);
        } else if (evt && evt.type === 'done') {
          res.write(`data: ${JSON.stringify(evt)}\n\n`);
        }
      }, { minChars: 60, maxWait: 180, emitThinking: true });

      // 保存 AI 回复
      if (assistantContent) {
        await insertMessage(sessionId, 'assistant', assistantContent, lastReasoningContent || null);
      }

      // 发送结束事件，并且返回 sessionId 便于前端保存
      res.write(`data: ${JSON.stringify({ type: 'done', sessionId })}\n\n`);
      res.end();
      return;
    }

    // 非流模式
    const completion = await callAI(allMessages, false, model);
    const reply = completion.choices[0].message;
    await insertMessage(sessionId, 'assistant', reply.content, null);

    res.json({ sessionId, reply });
  } catch (err) {
    res.status(500).json({ msg: 'AI服务调用失败', err: err.message });
  }
});

// Mock 聊天接口
aiRouter.post('/chat-mock', authMiddleware, async (req, res) => {
  const { stream, sessionId: clientSessionId } = req.body;
  const sessionId = clientSessionId || Date.now();

  if (!stream) {
    return res.json({
      sessionId,
      reply: {
        role: 'assistant',
        content: '这是 mock 的非流式回复，用于 UI 测试。'
      }
    });
  }

  setupSSEResponse(res);

  let isClientConnected = true;
  req.on('close', () => { isClientConnected = false; });

  // Mock 数据
  const mockRow = await dbGet(
    `SELECT content FROM chat_records WHERE id = ?`,
    [100]
  );
  const mockText = (mockRow && mockRow.content) ? mockRow.content : '这是 mock 的非流式回复，用于 UI 测试。';
  const chunks = mockText.match(/.{3,8}/g) || [];

  // 构造一个与 OpenAI 流式响应兼容的 async generator
  async function* mockCompletion() {
    for (const chunk of chunks) {
      yield { choices: [{ delta: { content: chunk } }] };
      await new Promise(r => setTimeout(r, 40 + Math.random() * 80));
    }
  }

  try {
    await handleBufferedStreamResponse(mockCompletion(), async (evt) => {
      if (!isClientConnected) return;
      if (evt && evt.type === 'delta') {
        res.write(`data: ${JSON.stringify(evt)}\n\n`);
      } else if (evt && evt.type === 'thinking') {
        res.write(`data: ${JSON.stringify({ type: 'thinking', thinking: evt.thinking })}\n\n`);
      }
    }, { minChars: 60, maxWait: 180 });
  } catch (err) {
    console.error('mock buffered SSE 错误:', err);
    // 降级：直接逐片段发送，确保前端能收到内容
    try {
      for (const c of chunks) {
        if (!isClientConnected) break;
        res.write(`data: ${JSON.stringify({ type: 'delta', text: c })}\n\n`);
        await new Promise(r => setTimeout(r, 40 + Math.random() * 80));
      }
    } catch (err2) {
      console.error('mock fallback SSE 错误:', err2);
    }
  }
  // 结束事件，包含 sessionId 便于前端保存
  res.write(`data: ${JSON.stringify({ type: 'done', sessionId })}\n\n`);
  res.end();
});

// 获取会话列表
aiRouter.get('/sessions', authMiddleware, async (req, res) => {
  const openid = req.user.openid;

  try {
    const sessions = await dbAll(
      `SELECT id, title, updated_at FROM sessions WHERE openid = ? ORDER BY updated_at DESC`,
      [openid]
    );
    res.json({ sessions });
  } catch (err) {
    res.status(500).json({ msg: '获取会话失败', err: err.message });
  }
});

// 获取会话消息
aiRouter.get('/sessions/:id/messages', authMiddleware, async (req, res) => {
  const sessionId = req.params.id;

  try {
    const messages = await dbAll(
      `SELECT id, role, content, reasoning_content , created_at, liked FROM chat_records WHERE session_id = ? ORDER BY created_at ASC`,
      [sessionId]
    );
    res.json({ messages });
  } catch (err) {
    res.status(500).json({ msg: '获取会话消息失败', err: err.message });
  }
});

// 删除会话
aiRouter.post('/sessions/:id/delete', authMiddleware, async (req, res) => {
  const sessionId = req.params.id;
  const openid = req.user.openid;

  try {
    const session = await dbGet(
      `SELECT id FROM sessions WHERE id = ? AND openid = ?`,
      [sessionId, openid]
    );

    if (!session) {
      return res.status(404).json({ msg: '会话不存在或无权限删除' });
    }

    await dbRun(`DELETE FROM chat_records WHERE session_id = ?`, [sessionId]);
    await dbRun(`DELETE FROM sessions WHERE id = ?`, [sessionId]);

    res.json({ msg: '删除成功', sessionId });
  } catch (err) {
    res.status(500).json({ msg: '删除失败', err: err.message });
  }
});

// 获取模型列表
aiRouter.get('/models', authMiddleware, async (req, res) => {
  try {
    const models = await openai.models.list();
    res.json({ models });
  } catch (err) {
    res.status(500).json({ msg: '获取模型失败', err: err.message });
  }
});

// 点赞消息
aiRouter.post('/messages/:id/like', authMiddleware, async (req, res) => {
  const messageId = req.params.id;
  try {
    const message = await dbGet(
      `SELECT id, liked FROM chat_records WHERE id = ?`,
      [messageId]
    );

    if (!message) {
      return res.status(500).json({ msg: '消息不存在' });
    }

    const newLikedStatus = message.liked ? 0 : 1;
    await dbRun(
      `UPDATE chat_records SET liked = ? WHERE id = ?`,
      [newLikedStatus, messageId]
    );

    res.json({ msg: '操作成功', messageId, liked: newLikedStatus });
  } catch (err) {
    res.status(500).json({ msg: '点赞操作失败', err: err.message });
  }
});

// 重新生成消息
aiRouter.post('/messages/:id/regenerate', authMiddleware, async (req, res) => {
  const messageId = req.params.id;
  const { stream, model } = req.body;
  const openid = req.user.openid;

  try {
    // 权限检查并获取消息（同时获取会话所属 openid）
    const message = await dbGet(
      `SELECT cr.id, cr.session_id, cr.created_at, cr.role, s.openid
       FROM chat_records cr
       JOIN sessions s ON cr.session_id = s.id
       WHERE cr.id = ?`,
      [messageId]
    );

    if (!message) return res.status(404).json({ msg: '消息不存在' });
    if (message.role !== 'assistant') return res.status(400).json({ msg: '仅可重新生成AI消息' });
    if (message.openid !== openid) return res.status(403).json({ msg: '无权限操作此消息' });

    const sessionId = message.session_id;

    // 获取会话历史（不包括该AI消息及之后的内容）
    const historyMessages = await getSessionHistory(sessionId, message.created_at);

    // 获取最后一条用户消息
    let userMessage = null;
    for (let i = historyMessages.length - 1; i >= 0; i--) {
      if (historyMessages[i].role === 'user') {
        userMessage = historyMessages[i].content;
        break;
      }
    }
    if (!userMessage) return res.status(400).json({ msg: '无法找到用户消息用于重新生成' });

    const messages = [...historyMessages, { role: 'user', content: userMessage }];

    if (stream) {
      setupSSEResponse(res);
      let isClientConnected = true;
      req.on('close', () => { isClientConnected = false; });

      const completion = await callAI(messages, true, model);
      let lastReasoningContent = null;
      const assistantContent = await handleBufferedStreamResponse(completion, async (evt) => {
        if (!isClientConnected) return;
        if (evt && evt.type === 'delta') {
          res.write(`data: ${JSON.stringify(evt)}\n\n`);
        } else if (evt && evt.type === 'thinking') {
          lastReasoningContent = evt.thinking;
          res.write(`data: ${JSON.stringify({ type: 'thinking', thinking: evt.thinking })}\n\n`);
        }
      }, { minChars: 60, maxWait: 180, emitThinking: true });

      if (assistantContent) {
        await updateMessage(messageId, assistantContent, lastReasoningContent);
      }
      res.write(`data: ${JSON.stringify({ type: 'done', sessionId })}\n\n`);
      res.end();
      return;
    }

    // 非流模式
    const completion = await callAI(messages, false, model);
    const reply = completion.choices[0].message;
    await updateMessage(messageId, reply.content, null);
    res.json({ messageId, newContent: reply.content });
  } catch (err) {
    res.status(500).json({ msg: '重新生成失败', err: err.message });
  }
});

// 语音转文本接口
aiRouter.post('/speech-to-text', authMiddleware, upload.single('audio'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ msg: '未提供音频文件或文件为空' });
    }

    // 临时文件路径（确保目录存在）
    const tempDir = path.resolve('./temp'); // 当前项目 temp 文件夹
    await fs.mkdir(tempDir, { recursive: true });

    const tempFilePath = path.join(tempDir, `audio_${Date.now()}.wav`);
    console.log('tempFilePath:', tempFilePath);
    console.log('req.file:', req.file);

    // 写入文件
    await fs.writeFile(tempFilePath, req.file.buffer);
    console.log('文件写入成功');

    // 调用 Whisper 转写
    const whisper = new Whisper(
      '/Users/mac/Downloads/Front-project/learn/wechat-ai-backend/whisper.cpp',
      'ggml-tiny.bin'
    );
    const text = await whisper.transcribe(tempFilePath, 'zh');

    // 删除临时文件
    await fs.unlink(tempFilePath);

    return res.json({
      msg: '语音识别成功',
      text
    });
  } catch (err) {
    console.error('语音识别失败:', err);
    res.status(500).json({ msg: '语音识别失败', err: err.message });
  }
});
