// Full-corpus markdown for AI agents — every published page in one
// document. Scope and collation live in the framework's build-time prepared
// artifact (it expands <Render> partials, which runtime renderers no longer
// do); reshape or delete this route to change the site's corpus policy.
import { getPreparedLlmsArtifact } from "@cloudflare/nimbus-docs/build";

export const prerender = true;

export async function GET() {
  const artifact = await getPreparedLlmsArtifact({ scope: "site", surface: "full" });
  return new Response(artifact.body, {
    headers: { "Content-Type": artifact.mediaType },
  });
}
