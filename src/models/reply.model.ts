import { Schema } from 'mongoose';
import { define } from './define';

const { ObjectId } = Schema.Types;

const schema = new Schema(
  {
    jobId: { type: ObjectId, ref: 'Job', required: true, index: true },
    candidateId: { type: ObjectId, ref: 'Candidate', required: true, index: true },
    text: { type: String, required: true },
    injectionFlag: { type: Boolean, default: false },
    label: {
      type: String,
      enum: ['interested', 'not_interested', 'question', 'wants_meeting', 'unsubscribe'],
    },
    confidence: Number,
    rationale: String,
    draftId: { type: ObjectId, ref: 'OutreachMessage' },
    handled: { type: Boolean, default: false },
    autoSent: { type: Boolean, default: false },
    // why auto-reply did not send this one (shown to the recruiter)
    autoNote: String,
    error: String,
  },
  { timestamps: true },
);

export const Reply = define<any>('Reply', schema);
