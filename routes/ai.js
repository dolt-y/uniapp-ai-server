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
// 创建新会话
function createSession(openid, title = '新会话') {
  const now = getLocalTimeString();
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO sessions (openid, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      [openid, title, now, now],
      function (err) {
        if (err) return reject(err);
        resolve(this.lastID); // 返回新会话 id
      }
    );
  });
}


// 顺序插入消息
function insertMessage(sessionId, role, content) {
  const now = getLocalTimeString();
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO chat_records(session_id, role, content, created_at) VALUES (?, ?, ?, ?)`,
      [sessionId, role, content, now],
      (err) => err ? reject(err) : resolve()
    );
  });
}


aiRouter.post('/chat', authMiddleware, async (req, res) => {
  const { messages, stream, sessionId: clientSessionId } = req.body;
  const openid = req.user.openid;

  if (!messages || !Array.isArray(messages) || !messages.every(msg => msg.role && msg.content && typeof msg.content === 'string')) {
    return res.status(400).json({ msg: 'messages格式不正确' });
  }

  try {
    let sessionId = clientSessionId;
    if (!sessionId) {
      sessionId = await createSession(openid, messages[0].content.slice(0, 10));
    }
    const historyMessages = await new Promise((resolve, reject) => {
      db.all(
        `SELECT role, content FROM chat_records WHERE session_id = ? ORDER BY created_at ASC`,
        [sessionId],
        (err, rows) => err ? reject(err) : resolve(rows)
      );
    });
    const allMessages = historyMessages.concat(messages);
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      let isClientConnected = true;
      req.on('close', () => {
        isClientConnected = false;
      });

      // 写入用户消息
      for (const msg of messages) {
        await insertMessage(sessionId, msg.role, msg.content);
      }

      const completion = await openai.chat.completions.create(
        { model: 'deepseek-chat', messages: [...allMessages], stream: true },
        { responseType: 'stream' }
      );

      try {
        for await (const event of completion) {
          if (!isClientConnected) break;
          const text = event.choices?.[0]?.delta?.content;
          if (text) {
            res.write(`data: ${text}\n\n`);
            await insertMessage(sessionId, 'assistant', text);
          }
        }
      } catch (err) {
        console.error('SSE chunk处理异常:', err);
      }

      res.write(`data: [DONE]\n\n`);
      res.end();
      return;
    }

    // 非流模式
    const completion = await openai.chat.completions.create({
      model: 'deepseek-chat',
      messages: [...allMessages]
    });
    const reply = completion.choices[0].message;
    console.log('reply:', reply)
    // 写入数据库
    for (const msg of messages) {
      await insertMessage(sessionId, msg.role, msg.content);
    }
    await insertMessage(sessionId, 'assistant', reply.content);

    res.json({ sessionId, reply });
  } catch (err) {
    res.status(500).json({ msg: 'AI服务调用失败', err: err.message });
  }
});

aiRouter.get('/sessions', authMiddleware, async (req, res) => {
  const openid = req.user.openid;

  db.all(
    `SELECT id, title, created_at 
     FROM sessions 
     WHERE openid = ? 
     ORDER BY created_at DESC`,
    [openid],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ msg: '获取会话失败', err: err.message });
      }
      res.json({ sessions: rows });
    }
  );
});
aiRouter.get('/sessions/:id/messages', authMiddleware, async (req, res) => {
  const sessionId = req.params.id;

  db.all(
    `SELECT role, content, created_at
     FROM chat_records
     WHERE session_id = ?
     ORDER BY created_at ASC`,
    [sessionId],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ msg: '获取会话消息失败', err: err.message });
      }
      res.json({ messages: rows });
    }
  );
});
aiRouter.delete('/sessions/:id', authMiddleware, async (req, res) => {
  const sessionId = req.params.id;
  const openid = req.user.openid;

  try {
    // 先检查会话是否存在且属于当前用户
    const session = await new Promise((resolve, reject) => {
      db.get(
        `SELECT id FROM sessions WHERE id = ? AND openid = ?`,
        [sessionId, openid],
        (err, row) => err ? reject(err) : resolve(row)
      );
    });

    if (!session) {
      return res.status(404).json({ msg: '会话不存在或无权限删除' });
    }

    // 删除聊天记录
    await new Promise((resolve, reject) => {
      db.run(
        `DELETE FROM chat_records WHERE session_id = ?`,
        [sessionId],
        (err) => err ? reject(err) : resolve()
      );
    });

    // 删除会话
    await new Promise((resolve, reject) => {
      db.run(
        `DELETE FROM sessions WHERE id = ?`,
        [sessionId],
        (err) => err ? reject(err) : resolve()
      );
    });

    res.json({ msg: '删除成功', sessionId });
  } catch (err) {
    res.status(500).json({ msg: '删除失败', err: err.message });
  }
});

aiRouter.get('/models', authMiddleware, async (req, res) => {
  try {
    const models = await openai.models.list();
    res.json({ models });
  } catch (err) {
    res.status(500).json({ msg: '获取模型失败', err: err.message });
  }
});
