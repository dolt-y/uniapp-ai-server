import express from 'express';
import { authMiddleware } from '../middleware/auth.js';

export const dataRouter = express.Router();

dataRouter.get('/list', authMiddleware, (req,res)=>{
  const data = [
    { id:1, name:'商品A', price:100 },
    { id:2, name:'商品B', price:200 },
    { id:3, name:'商品C', price:300 }
  ];
  res.json({ list:data });
});
