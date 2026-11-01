import { Schema } from 'mongoose';
import { define } from './define';

const { ObjectId } = Schema.Types;

const schema = new Schema(
  {
    campaignId: { type: ObjectId, ref: 'Campaign', index: true },
    jobId: { type: ObjectId, ref: 'Job', required: true, index: true },
    candidateId: { type: ObjectId, ref: 'Candidate', required: true, index: true },
    kind: { type: String, enum: ['outreach', 'reply'], default: 'outreach' },
    replyId: { type: ObjectId, ref: 'Reply' },
    stepIndex: { type: Number, default: 0 },
    // outreach: campaign:candidate:step. reply: reply:<id>. Stops the same message being created twice.
    uniqueKey: { type: String, required: true, unique: true },
    subject: { type: String, default: '' },
    body: { type: String, default: '' },
    status: {
      type: String,
      enum: ['draft', 'scheduled', 'sending', 'sent', 'failed', 'skipped', 'cancelled'],
      default: 'draft',
      index: true,
    },
    scheduledFor: Date,
    sentAt: Date,
    attempts: { type: Number, default: 0 },
    transport: String,
    providerId: String,
    note: String,
    error: String,
  },
  { timestamps: true },
);
schema.index({ status: 1, scheduledFor: 1 });

export const OutreachMessage = define<any>('OutreachMessage', schema);
