import { Schema } from 'mongoose';
import { define } from './define';

const { ObjectId, Mixed } = Schema.Types;

const schema = new Schema(
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

export const ActivityLog = define<any>('ActivityLog', schema);
