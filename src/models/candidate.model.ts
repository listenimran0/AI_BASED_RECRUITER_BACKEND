import { Schema } from 'mongoose';
import { define } from './define';
import { STATUSES } from './constants';

const { ObjectId } = Schema.Types;

const schema = new Schema(
  {
    jobId: { type: ObjectId, ref: 'Job', required: true, index: true },
    name: { type: String, required: true },
    email: { type: String, lowercase: true, trim: true },
    profileUrl: String,
    urlKey: String,
    headline: String,
    company: String,
    location: String,
    skills: { type: [String], default: [] },
    snippet: String,
    notes: String,
    source: { type: String, enum: ['serper', 'csv', 'mock-search'], required: true },
    // email if we have one, otherwise the normalised profile url. Unique per job.
    dedupeKey: { type: String, required: true },
    status: { type: String, enum: STATUSES, default: 'sourced', index: true },
    score: Number,
    scoreReason: String,
    matchedSkills: { type: [String], default: [] },
    missingSkills: { type: [String], default: [] },
    dataQuality: String,
    scoreError: String,
    injectionFlag: { type: Boolean, default: false },
    bookingToken: String,
    runId: { type: ObjectId, ref: 'SourcingRun' },
  },
  { timestamps: true },
);
schema.index({ jobId: 1, dedupeKey: 1 }, { unique: true });
schema.index({ bookingToken: 1 });
schema.index({ jobId: 1, urlKey: 1 });

export const Candidate = define<any>('Candidate', schema);
