import { Schema } from 'mongoose';
import { define } from './define';

const { ObjectId, Mixed } = Schema.Types;

const schema = new Schema(
  {
    conversationId: { type: ObjectId, ref: 'Conversation', index: true },
    type: { type: String, required: true },
    title: { type: String, required: true },
    payload: { type: Mixed, required: true },
    status: { type: String, enum: ['pending', 'running', 'done', 'cancelled', 'failed'], default: 'pending' },
    result: Mixed,
    error: String,
  },
  { timestamps: true },
);

export const PendingAction = define<any>('PendingAction', schema);
