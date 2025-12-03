import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import OpenAI from 'openai';
import { config } from '../config.js';
import { db } from '../db.js';

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

// 数据库操作 Promise 化
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

// 会话操作
function createSession(openid, title = '新会话') {
  const now = getLocalTimeString();
  return dbRun(
    `INSERT INTO sessions (openid, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    [openid, title, now, now]
  ).then(result => result.lastID);
}

function updateSession(sessionId, newTitle) {
  const now = getLocalTimeString();
  return dbRun(
    `UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?`,
    [newTitle, now, sessionId]
  );
}

// 消息操作
function insertMessage(sessionId, role, content) {
  const now = getLocalTimeString();
  return dbRun(
    `INSERT INTO chat_records(session_id, role, content, created_at) VALUES (?, ?, ?, ?)`,
    [sessionId, role, content, now]
  );
}

function updateMessage(messageId, content) {
  const now = getLocalTimeString();
  return dbRun(
    `UPDATE chat_records SET content = ?, created_at = ? WHERE id = ?`,
    [content, now, messageId]
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
async function callAI(messages, stream = false) {
  const completion = await openai.chat.completions.create(
    {
      model: 'deepseek-reasoner',
      messages,
      stream,
      extra_body: { thinking: { type: "enabled" } }
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

  let buffer = '';
  let lastEmit = Date.now();
  let full = '';

  try {
    for await (const event of completion) {
      const text = event.choices?.[0]?.delta?.content;
      if (!text) continue;
      buffer += text;
      full += text;

      const now = Date.now();
      const shouldByLength = buffer.length >= minChars;
      const shouldByBoundary = boundaryRegex.test(buffer);
      const shouldByTime = (now - lastEmit) >= maxWait && buffer.length > 0;

      if (shouldByBoundary || shouldByLength || shouldByTime) {
        // 发送当前 buffer
        await emitFn(buffer);
        buffer = '';
        lastEmit = Date.now();
      }
    }
  } catch (err) {
    console.error('缓冲流式响应处理异常:', err);
  }

  // 流结束前将剩余 buffer 发出
  if (buffer.length > 0) {
    await emitFn(buffer);
  }
  return full;
}

// ==================== 路由处理 ====================

// 聊天接口
aiRouter.post('/chat', authMiddleware, async (req, res) => {
  const { messages, stream, sessionId: clientSessionId } = req.body;
  const openid = req.user.openid;

  if (!messages || !Array.isArray(messages) || !messages.every(msg => msg.role && msg.content && typeof msg.content === 'string')) {
    return res.status(400).json({ msg: 'messages格式不正确' });
  }

  try {
    // 获取或创建会话
    let sessionId = clientSessionId;
    if (!sessionId) {
      sessionId = await createSession(openid, messages[0].content);
    } else {
      // await updateSession(sessionId, messages[0].content);
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
      const completion = await callAI(allMessages, true);
      const assistantContent = await handleBufferedStreamResponse(completion, async (chunk) => {
        console.log('assistant:', chunk);
        if (isClientConnected) {
          // 以 JSON 事件发送合并后的片段，便于前端按事件重组与 markdown 渲染
          res.write(`data: ${JSON.stringify({ type: 'delta', text: chunk })}\n\n`);
        }
      }, { minChars: 60, maxWait: 180 });

      // 保存 AI 回复
      if (assistantContent) {
        await insertMessage(sessionId, 'assistant', assistantContent);
      }

      // 发送结束事件
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();
      return;
    }

    // 非流模式
    const completion = await callAI(allMessages);
    const reply = completion.choices[0].message;
    await insertMessage(sessionId, 'assistant', reply.content);

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
  // req.on('close', () => { isClientConnected = false; });

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
    await handleBufferedStreamResponse(mockCompletion(), async (chunk) => {
      if (isClientConnected) {
        res.write(`data: ${JSON.stringify({ type: 'delta', text: chunk })}\n\n`);
      }
    }, { minChars: 60, maxWait: 180 });
  } catch (err) {
    console.error('mock buffered SSE 错误:', err);
    // 降级：直接逐片段发送，确保前端能收到内容
    try {
      for (const chunk of chunks) {
        if (!isClientConnected) break;
        res.write(`data: ${JSON.stringify({ type: 'delta', text: chunk })}\n\n`);
        // 保持与 mockCompletion 中相近的发送速率
        await new Promise(r => setTimeout(r, 40 + Math.random() * 80));
      }
    } catch (err2) {
      console.error('mock fallback SSE 错误:', err2);
    }
  }

  res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
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
      `SELECT id, role, content, created_at, liked FROM chat_records WHERE session_id = ? ORDER BY created_at ASC`,
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
      return res.status(404).json({ msg: '消息不存在' });
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
  const { stream } = req.body;
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

      const completion = await callAI(messages, true);
      const assistantContent = await handleBufferedStreamResponse(completion, async (chunk) => {
        if (isClientConnected) {
          res.write(`data: ${JSON.stringify({ type: 'delta', text: chunk })}\n\n`);
        }
      }, { minChars: 60, maxWait: 180 });

      if (assistantContent) {
        await updateMessage(messageId, assistantContent);
      }

      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();
      return;
    }

    // 非流模式
    const completion = await callAI(messages);
    const reply = completion.choices[0].message;
    await updateMessage(messageId, reply.content);
    res.json({ messageId, newContent: reply.content });
  } catch (err) {
    res.status(500).json({ msg: '重新生成失败', err: err.message });
  }
});
