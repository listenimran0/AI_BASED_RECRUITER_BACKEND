import { Schema } from 'mongoose';
import { define } from './define';

const { ObjectId } = Schema.Types;

const schema = new Schema(
  {
    conversationId: { type: ObjectId, ref: 'Conversation', index: true },
    title: { type: String, required: true },
    seniority: String,
    location: String,
    remotePolicy: { type: String, enum: ['remote', 'hybrid', 'onsite', 'unknown'], default: 'unknown' },
    salary: { min: Number, max: Number, currency: String, period: String, text: String },
    mustHaveSkills: { type: [String], default: [] },
    niceToHaveSkills: { type: [String], default: [] },
    summary: String,
    sourceUrl: String,
    status: { type: String, enum: ['open', 'closed'], default: 'open' },
    autoReply: { type: Boolean, default: false },
  },
  { timestamps: true },
);

export const Job = define<any>('Job', schema);
