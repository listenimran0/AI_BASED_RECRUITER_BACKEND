import { Schema } from 'mongoose';
import { define } from './define';

const { ObjectId, Mixed } = Schema.Types;

const schema = new Schema(
  {
    conversationId: { type: ObjectId, ref: 'Conversation', index: true, required: true },
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, default: '' },
    cards: { type: [{ type: { type: String }, ref: Mixed, _id: false }], default: [] },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export const Message = define<any>('Message', schema);
