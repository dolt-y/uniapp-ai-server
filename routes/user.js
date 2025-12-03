import express from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { db } from '../db.js';
import { config } from '../config.js';
import { authMiddleware } from '../middleware/auth.js';

export const userRouter = express.Router();

// 登录
userRouter.post('/login', async (req, res) => {
  const { code, userInfo } = req.body;
  if (!code) return res.status(400).json({ msg: 'code不能为空' });

  try {
    const response = await axios.get('https://api.weixin.qq.com/sns/jscode2session', {
      params: {
        appid: config.wxAppId,
        secret: config.wxAppSecret,
        js_code: code,
        grant_type: 'authorization_code'
      }
    });

    const data = response.data;
    if (data.errcode) return res.status(400).json(data);

    const openid = data.openid;

    const token = jwt.sign(
      { openid },
      config.jwtSecret,
      { expiresIn: '1d' }
    );

    db.run(`
      INSERT INTO users(openid, nickname, avatarUrl, lastLogin)
      VALUES(?,?,?,datetime('now'))
      ON CONFLICT(openid) DO UPDATE SET
        nickname=excluded.nickname,
        avatarUrl=excluded.avatarUrl,
        lastLogin=datetime('now')
    `,
      [
        openid,
        userInfo?.nickName || '',
        userInfo?.avatarUrl || ''
      ],
      (err) => {
        if (err) {
          return res.status(500).json({ msg: '数据库写入失败', err: err.message });
        }

        res.json({ token, msg: '登录成功' });
      }
    );

  } catch (err) {
    res.status(500).json({ msg: '微信接口调用失败', err: err.message });
  }
});


// 获取用户信息
userRouter.get('/info', authMiddleware, (req, res) => {
  const openid = req.user.openid;

  db.get(`SELECT * FROM users WHERE openid = ?`, [openid], (err, row) => {
    if (err) return res.status(500).json({ msg: err.message });
    if (!row) return res.status(404).json({ msg: '用户不存在' });

    res.json({ msg: '获取成功', user: row });
  });
});


// 刷新 token
// ⚠️ 注意：这个刷新机制基于 access token 未过期
userRouter.post('/refresh', authMiddleware, (req, res) => {
  const newToken = jwt.sign(
    { openid: req.user.openid },
    config.jwtSecret,
    { expiresIn: '7d' }
  );

  res.json({ token: newToken, msg: '刷新成功' });
});
