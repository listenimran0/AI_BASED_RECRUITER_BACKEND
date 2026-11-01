import { Schema } from 'mongoose';
import { define } from './define';

const { ObjectId } = Schema.Types;

const schema = new Schema(
  {
    title: { type: String, default: 'New chat' },
    activeJobId: { type: ObjectId, ref: 'Job' },
  },
  { timestamps: true },
);

export const Conversation = define<any>('Conversation', schema);
