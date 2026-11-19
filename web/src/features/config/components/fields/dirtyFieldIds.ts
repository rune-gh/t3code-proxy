import { createContext } from 'react';

/**
 * Field ids with unsaved edits. A startup-only setting shows its "Restart required" marker only
 * while it has one, so an untouched page does not look like it needs a restart; saving such a
 * change raises its own restart notification.
 */
export const DirtyFieldIdsContext = createContext<ReadonlySet<string>>(new Set());
