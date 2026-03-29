import { copyFile, readdir, access } from 'node:fs/promises';
import { join, extname } from 'node:path';

/**
 * Sanitize a step ID for use as a filename.
 * Replaces @, :, and path separators to prevent directory traversal.
 */
export function sanitizeStepId(stepId) {
  return stepId.replace(/[@:/\\]/g, '_').replace(/\.\./g, '_');
}

/**
 * Assign screencast-frame screenshots to steps based on timestamp window.
 *
 * @param {Array} screenshots - [{sha1, timestamp, ...}]
 * @param {Array} stepsRaw - steps with startTime/endTime (raw monotonicTime)
 * @param {string} resourcesDir - path to resources/ directory
 * @param {string[]} warnings
 * @returns {Array<{sha1, stepId, label, ext}>} assignments
 */
export function assignScreenshots(screenshots, stepsRaw, resourcesDir, warnings = []) {
  // Sort steps by startTime
  const sortedSteps = stepsRaw
    .filter(s => s.startTime != null)
    .sort((a, b) => a.startTime - b.startTime);

  const assignments = [];

  for (const frame of screenshots) {
    const ts = frame.timestamp;
    const sha1 = frame.sha1;
    const ext = extname(sha1) || '.jpeg';

    // Find step whose [startTime, endTime] contains this timestamp
    let assigned = null;
    for (const step of sortedSteps) {
      const start = step.startTime;
      const end = step.endTime ?? Infinity;
      if (ts >= start && ts <= end) {
        // Determine before/after based on midpoint
        const mid = (start + (step.endTime ?? start)) / 2;
        const label = ts < mid || (ts === mid) ? 'before' : 'after';
        assigned = { sha1, stepId: step.id, label, ext };
        break;
      }
    }

    if (!assigned) {
      // Assign to nearest step by absolute delta
      let minDelta = Infinity;
      let nearestStep = null;
      for (const step of sortedSteps) {
        const mid = (step.startTime + (step.endTime ?? step.startTime)) / 2;
        const delta = Math.abs(ts - mid);
        if (delta < minDelta) {
          minDelta = delta;
          nearestStep = step;
        }
      }

      if (nearestStep && minDelta <= 500) {
        const mid = (nearestStep.startTime + (nearestStep.endTime ?? nearestStep.startTime)) / 2;
        const label = ts <= mid ? 'before' : 'after';
        assigned = { sha1, stepId: nearestStep.id, label, ext };
      } else {
        // Unassigned — too far from any step
        const unassignedName = `unassigned-${sha1.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        assignments.push({ sha1, stepId: null, label: null, ext, unassignedName });
        warnings.push(`Screenshot ${sha1} could not be assigned to any step (nearest delta: ${Math.round(minDelta)}ms)`);
        continue;
      }
    }

    assignments.push(assigned);
  }

  // Second pass: detect duplicates by stepId+label and add seq numbers
  const countMap = new Map(); // key -> count
  for (const a of assignments) {
    if (!a.stepId) continue;
    const key = `${a.stepId}\0${a.label}`;
    countMap.set(key, (countMap.get(key) || 0) + 1);
  }
  const seqMap = new Map(); // key -> next seq
  for (const a of assignments) {
    if (!a.stepId) continue;
    const key = `${a.stepId}\0${a.label}`;
    if (countMap.get(key) > 1) {
      const seq = (seqMap.get(key) || 0) + 1;
      seqMap.set(key, seq);
      a.seq = seq;
    }
  }

  return assignments;
}

/**
 * Copy screenshot resources to the output screenshots/ directory.
 *
 * @param {Array} assignments - from assignScreenshots
 * @param {string} resourcesDir - source resources directory
 * @param {string} outputScreenshotsDir - destination screenshots/ directory
 * @param {string[]} warnings
 */
export async function copyScreenshots(assignments, resourcesDir, outputScreenshotsDir, warnings = []) {
  for (const a of assignments) {
    const srcPath = join(resourcesDir, a.sha1);

    // Check if source exists
    try {
      await access(srcPath);
    } catch {
      warnings.push(`Screenshot resource not found: ${a.sha1}`);
      continue;
    }

    let destName;
    if (a.stepId) {
      destName = a.seq
        ? `${sanitizeStepId(a.stepId)}-${a.label}-${String(a.seq).padStart(3, '0')}${a.ext}`
        : `${sanitizeStepId(a.stepId)}-${a.label}${a.ext}`;
    } else {
      destName = `${a.unassignedName}`;
    }

    await copyFile(srcPath, join(outputScreenshotsDir, destName));
  }
}

/**
 * Assign frame-snapshot DOM events to steps by callId match.
 * Returns mapping from stepId -> snapshot data.
 *
 * @param {Array} frameSnapshots - parsed frame snapshot events
 * @param {Map} stepMap - callId -> step (from stepsRaw)
 * @returns {{ domAssignments: Map<string, object>, unassigned: Array }}
 */
export function assignDomSnapshots(frameSnapshots, stepMap) {
  const domAssignments = new Map(); // stepId -> snapshot (latest per step)
  const unassigned = [];

  for (const snap of frameSnapshots) {
    const callId = snap.callId;
    if (callId && stepMap.has(callId)) {
      const step = stepMap.get(callId);
      // Keep latest snapshot per step (overwrite)
      domAssignments.set(step.id, snap);
    } else {
      unassigned.push(snap);
    }
  }

  return { domAssignments, unassigned };
}
