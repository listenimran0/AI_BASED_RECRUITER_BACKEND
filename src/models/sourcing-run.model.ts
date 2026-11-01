import { Schema } from 'mongoose';
import { define } from './define';

const { ObjectId } = Schema.Types;

const schema = new Schema(
  {
    jobId: { type: ObjectId, ref: 'Job', required: true, index: true },
    conversationId: { type: ObjectId, ref: 'Conversation' },
    kind: { type: String, enum: ['web', 'csv'], required: true },
    status: { type: String, enum: ['queued', 'searching', 'scoring', 'done', 'failed'], default: 'queued' },
    target: { type: Number, default: 30 },
    found: { type: Number, default: 0 },
    duplicates: { type: Number, default: 0 },
    scored: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    enqueueDone: { type: Boolean, default: false },
    queries: { type: [String], default: [] },
    note: String,
    error: String,
  },
  { timestamps: true },
);

export const SourcingRun = define<any>('SourcingRun', schema);
