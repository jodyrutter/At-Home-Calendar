import { runInternetSpeedTest, listSpeedtestProfiles } from "../speedtest/runner.js";

function parseArgs(argv) {
  const options = {
    profile: "hourly"
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--profile" && argv[index + 1]) {
      options.profile = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === "--pretty") {
      options.pretty = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      options.help = true;
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  console.log(
    [
      "Usage: node scripts/run-hearthboard-speedtest.mjs [--profile background|manual|hourly] [--pretty]",
      "",
      "Profiles: " + listSpeedtestProfiles().join(", ")
    ].join("\n")
  );
  process.exit(0);
}

try {
  const sample = await runInternetSpeedTest({ profile: options.profile });
  const payload = {
    ts: new Date().toISOString(),
    profile: options.profile,
    downloadMbps: Number(sample.downloadMbps.toFixed(2)),
    uploadMbps: Number(sample.uploadMbps.toFixed(2)),
    latencyMs: Number(sample.latencyMs.toFixed(1)),
    target: sample.target,
    serverLocation: sample.serverLocation,
    providerId: sample.providerId
  };
  console.log(JSON.stringify(payload, null, options.pretty ? 2 : 0));
} catch (err) {
  console.error(String(err?.message || err));
  process.exit(1);
}
