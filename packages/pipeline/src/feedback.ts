/** Conservative feedback: small samples cannot overwhelm the signal detector. */
export function feedbackMultiplier(samples: number, viewsPerHour: number, baseline: number): number {
  if (samples < 5 || baseline <= 0 || !Number.isFinite(viewsPerHour) || viewsPerHour < 0) return 1;
  const confidence = samples / (samples + 20);
  const relative = Math.max(-0.5, Math.min(1, viewsPerHour / baseline - 1));
  return 1 + confidence * relative;
}
