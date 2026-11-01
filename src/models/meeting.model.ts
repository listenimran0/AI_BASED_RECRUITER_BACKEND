import { Schema } from 'mongoose';
import { define } from './define';

const { ObjectId } = Schema.Types;

const schema = new Schema(
  {
    jobId: { type: ObjectId, ref: 'Job', required: true, index: true },
    candidateId: { type: ObjectId, ref: 'Candidate', required: true, unique: true },
    slot: { type: Date, required: true },
  },
  { timestamps: true },
);

// one candidate per time slot within a job, so two people cannot book the same time
schema.index({ jobId: 1, slot: 1 }, { unique: true });

export const Meeting = define<any>('Meeting', schema);
