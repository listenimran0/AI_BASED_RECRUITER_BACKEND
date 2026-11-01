import mongoose from 'mongoose';
import { config } from './config';
import { log } from './logger';

mongoose.set('toJSON', {
  virtuals: false,
  versionKey: false,
  transform: (_doc, ret: Record<string, any>) => {
    if (ret._id !== undefined) {
      ret.id = String(ret._id);
      delete ret._id;
    }
    return ret;
  },
});

export async function connectDb() {
  await mongoose.connect(config.mongoUrl, { serverSelectionTimeoutMS: 10_000 });
  log.info('mongo connected');
}
