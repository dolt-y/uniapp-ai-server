import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import { config } from './config.js';

import { userRouter } from './routes/user.js';
import { dataRouter } from './routes/data.js';
import { aiRouter } from './routes/ai.js';

const app = express();
app.use(cors());
app.use(bodyParser.json());

app.use('/api/user', userRouter);
app.use('/api/data', dataRouter);
app.use('/api/ai', aiRouter);

app.listen(config.port, ()=>{
  console.log(`Server running at http://localhost:${config.port}`);
});
