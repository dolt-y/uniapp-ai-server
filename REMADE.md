# 项目概要需求文档

## 一、项目目标
实现一个小程序后端服务，支持通过拍照或语音输入题目，并返回题目解析结果。

## 二、核心功能
1. 图片识别（OCR）
2. 语音识别（ASR）
3. AI 解题分析
4. 历史记录存储与查询
5. 用户鉴权
6. 文件上传与存储

## 三、基础流程
1. 小程序上传图片或语音至后端
2. 后端上传文件至云存储
3. OCR 或 ASR 将图片/语音转为文本
4. AI 模型根据文本进行解析
5. 结果保存到数据库
6. 返回解析内容到小程序端展示

## 四、后端模块设计
- upload：文件上传处理
- ocr：图片识别模块
- asr：语音识别模块
- ai：大模型调用模块
- question：历史记录与收藏
- auth：小程序用户鉴权
- db：数据库操作层

## 五、技术选型
- 后端框架：Node.js + NestJS
- 数据库：MongoDB
- 文件存储：OSS/COS
- OCR：百度 OCR
- ASR：阿里云语音识别
- AI：GPT/DeepSeek/Qwen

## 六、接口概要
- POST /upload
- POST /ocr
- POST /asr
- POST /ai/solve
- GET /question/history
- POST /question/favorite
- DELETE /question

## 七、数据结构概要
字段示例（简化版）：
userId, fileUrl, text, aiResult, createdAt, favorite

## 八、非功能需求
- 可靠性：失败重试、异常日志
- 安全性：openid 鉴权、文件签名校验
- 性能：平均响应时间控制在 8 秒以内

