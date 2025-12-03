import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import { config } from './config.js';

import { userRouter } from './routes/user.js';
import { aiRouter } from './routes/ai.js';

const app = express();
app.use(cors());
app.use(bodyParser.json());

app.use('/api/user', userRouter);
app.use('/api/ai', aiRouter);

const host = '10.3.20.101';

app.listen(config.port, host, () => {
  console.log(`Server running at http://${host}:${config.port}`);
});

