async function main(): Promise<void> {
  const response = await fetch("http://localhost:3000/build-events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      buildId: "build-1842",
      release: "cli-v2.7.0",
      capability: "developer-tools",
      provider: "vendor-a",
      outcome: "failed",
    }),
  });

  const result: unknown = await response.json();
  console.log(JSON.stringify(result, null, 2));
  if (!response.ok) process.exitCode = 1;
}

void main();
