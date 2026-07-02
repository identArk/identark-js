/**
 * Control Plane Gateway Example
 *
 * Connect to the IdentArk cloud control plane for production deployments.
 */

import { ControlPlaneGateway } from "@identark/sdk";

const gateway = new ControlPlaneGateway({
  apiKey: process.env.IDENTARK_API_KEY!,
  baseUrl: "https://api.identark.io/v1",
  credentialRef: "secret/orgs/acme/providers/openai",
});

async function main() {
  const response = await gateway.invokeLlm([
    { role: "user", content: "Generate a summary of Q3 earnings." },
  ]);

  console.log("Response:", response.message.content);
  console.log("Model:", response.model);
  console.log("Cost:", response.cost_usd);
}

main().catch(console.error);
