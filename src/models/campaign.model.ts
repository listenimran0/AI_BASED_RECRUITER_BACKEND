import { Schema } from 'mongoose';
import { define } from './define';

const { ObjectId } = Schema.Types;

const schema = new Schema(
  {
    jobId: { type: ObjectId, ref: 'Job', required: true, index: true },
    conversationId: { type: ObjectId, ref: 'Conversation' },
    name: { type: String, required: true },
    status: {
      type: String,
      enum: ['drafting', 'ready', 'active', 'paused', 'completed', 'failed'],
      default: 'drafting',
    },
    steps: { type: [{ dayOffset: Number, goal: String, _id: false }], default: [] },
    tone: String,
    dailyLimit: { type: Number, default: 20 },
    candidateIds: { type: [ObjectId], default: [] },
    draftsDone: { type: Number, default: 0 },
    draftsFailed: { type: Number, default: 0 },
    approvedAt: Date,
  },
  { timestamps: true },
);

export const Campaign = define<any>('Campaign', schema);
