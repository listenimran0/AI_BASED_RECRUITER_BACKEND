import { model, models, type Model, type Schema } from 'mongoose';

// reuse an already-registered model so hot reload and tests do not redefine it
export function define<T>(name: string, schema: Schema): Model<T> {
  return (models[name] as Model<T>) || model<T>(name, schema);
}
