import { Schema } from 'mongoose';
import { define } from './define';

const { ObjectId } = Schema.Types;

const schema = new Schema(
  {
    jobId: { type: ObjectId, ref: 'Job', index: true },
    conversationId: { type: ObjectId, ref: 'Conversation' },
    purpose: { type: String, required: true },
    model: String,
    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    costUsd: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export const LlmUsage = define<any>('LlmUsage', schema);
