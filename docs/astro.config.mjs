// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLlmsTxt from "starlight-llms-txt";

// Deploy defaults target this repo's GitHub Pages project URL
// (https://danielscholl.github.io/keelson-rib-chamber/). For a custom domain, set
// base to "/" and add a CNAME.
export default defineConfig({
  site: "https://danielscholl.github.io",
  base: "/keelson-rib-chamber",
  trailingSlash: "always",
  integrations: [
    starlight({
      title: "Keelson Rib · Chamber",
      description:
        "Chamber as a Keelson rib: genesis agents, agent-to-agent rooms, and agent-authored lenses on the canvas substrate.",
      favicon: "/assets/keelson-mark.svg",
      customCss: ["./src/styles/keelson-theme.css"],
      // Emits /llms.txt, /llms-full.txt, /llms-small.txt at build (llmstxt.org).
      plugins: [
        starlightLlmsTxt({
          projectName: "Keelson Rib · Chamber",
          description:
            "A Keelson rib that adds the generative half of Chamber: genesis agents, agent-to-agent rooms, and agent-authored lenses rendered through the canvas.",
        }),
      ],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/danielscholl/keelson-rib-chamber",
        },
      ],
      sidebar: [
        { label: "Overview", link: "/" },
        { label: "Concepts", items: [{ autogenerate: { directory: "concepts" } }] },
        { label: "Guides", items: [{ autogenerate: { directory: "guides" } }] },
        { label: "Tutorials", items: [{ autogenerate: { directory: "tutorials" } }] },
        { label: "Reference", items: [{ autogenerate: { directory: "reference" } }] },
        { label: "Design", items: [{ autogenerate: { directory: "design" } }] },
      ],
    }),
  ],
});
