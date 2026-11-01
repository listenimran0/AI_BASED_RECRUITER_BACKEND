import { Schema, model, models, type Model } from 'mongoose';

const { ObjectId, Mixed } = Schema.Types;

function define<T>(name: string, schema: Schema): Model<T> {
  return (models[name] as Model<T>) || model<T>(name, schema);
}

export const STATUSES = [
  'sourced',
  'accepted',
  'rejected',
  'contacted',
  'replied',
  'interested',
  'not_interested',
  'meeting_booked',
  'interviewed',
  'shortlisted',
  'hired',
  'unsubscribed',
] as const;
export type Status = (typeof STATUSES)[number];

export type CardRef = { type: string; ref: Record<string, unknown> };

const conversationSchema = new Schema(
  {
    title: { type: String, default: 'New chat' },
    activeJobId: { type: ObjectId, ref: 'Job' },
  },
  { timestamps: true },
);

const messageSchema = new Schema(
  {
    conversationId: { type: ObjectId, ref: 'Conversation', index: true, required: true },
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, default: '' },
    cards: { type: [{ type: { type: String }, ref: Mixed, _id: false }], default: [] },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

const jobSchema = new Schema(
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

const candidateSchema = new Schema(
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
candidateSchema.index({ jobId: 1, dedupeKey: 1 }, { unique: true });
candidateSchema.index({ bookingToken: 1 });
candidateSchema.index({ jobId: 1, urlKey: 1 });

const activitySchema = new Schema(
  {
    jobId: { type: ObjectId, ref: 'Job', required: true, index: true },
    candidateId: { type: ObjectId, ref: 'Candidate', index: true },
    actor: { type: String, required: true },
    type: { type: String, required: true },
    from: String,
    to: String,
    message: { type: String, required: true },
    meta: Mixed,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

const runSchema = new Schema(
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

const campaignSchema = new Schema(
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

const outreachSchema = new Schema(
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
outreachSchema.index({ status: 1, scheduledFor: 1 });

const replySchema = new Schema(
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

const actionSchema = new Schema(
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

const usageSchema = new Schema(
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

const meetingSchema = new Schema(
  {
    jobId: { type: ObjectId, ref: 'Job', required: true, index: true },
    candidateId: { type: ObjectId, ref: 'Candidate', required: true, unique: true },
    slot: { type: Date, required: true },
  },
  { timestamps: true },
);

// one candidate per time slot within a job, so two people cannot book the same time
meetingSchema.index({ jobId: 1, slot: 1 }, { unique: true });

export const Conversation = define<any>('Conversation', conversationSchema);
export const Message = define<any>('Message', messageSchema);
export const Job = define<any>('Job', jobSchema);
export const Candidate = define<any>('Candidate', candidateSchema);
export const ActivityLog = define<any>('ActivityLog', activitySchema);
export const SourcingRun = define<any>('SourcingRun', runSchema);
export const Campaign = define<any>('Campaign', campaignSchema);
export const OutreachMessage = define<any>('OutreachMessage', outreachSchema);
export const Reply = define<any>('Reply', replySchema);
export const PendingAction = define<any>('PendingAction', actionSchema);
export const LlmUsage = define<any>('LlmUsage', usageSchema);
export const Meeting = define<any>('Meeting', meetingSchema);
