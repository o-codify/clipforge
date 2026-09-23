try {
  const response = await fetch("http://127.0.0.1:3000/api/health/ready", { signal: AbortSignal.timeout(6000) });
  if (!response.ok || (await response.json()).status !== "ready") process.exit(1);
} catch { process.exit(1); }
