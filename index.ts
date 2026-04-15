import { Type } from "@sinclair/typebox";
import { wrapFetch, type WrapFetchOptions } from "@dexterai/x402/client";

// =============================================================================
// Types
// =============================================================================

type PluginConfig = {
  svmPrivateKey?: string;
  evmPrivateKey?: string;
  defaultNetwork?: string;
  maxPaymentUSDC?: string;
  facilitatorUrl?: string;
  marketplaceUrl?: string;
};

/**
 * Flat legacy-compatible shape for each result. Same field names the
 * original `MarketplaceResource` exposed, plus new fields grafted on
 * from the capability search response: `tier`, `similarity`, `why`,
 * `score`, `gamingFlags`, `gamingSuspicious`.
 */
type FlatSearchResource = {
  resourceId: string;
  name: string;
  url: string;
  method: string;
  price: string;
  priceUsdc: number | null;
  network: string | null;
  description: string;
  category: string;
  qualityScore: number | null;
  verified: boolean;
  verificationStatus: string;
  totalCalls: number;
  totalVolumeUsdc: number;
  host: string | null;
  iconUrl: string | null;
  gamingFlags: string[];
  gamingSuspicious: boolean;
  tier: "strong" | "related";
  similarity: number;
  why: string;
  score: number;
};

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_FACILITATOR_URL = "https://x402.dexter.cash";
/**
 * Capability search endpoint — semantic vector search over the x402 corpus
 * with synonym expansion, similarity floor, strong/related tiering, and
 * cross-encoder LLM rerank. Replaces the legacy substring ranker at
 * `/api/facilitator/marketplace/resources`, which was removed from
 * dexter-api on 2026-04-15.
 */
const DEFAULT_CAPABILITY_URL =
  "https://x402.dexter.cash/api/x402gle/capability";

const NETWORK_TO_CAIP2: Record<string, string> = {
  solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "solana-devnet": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  base: "eip155:8453",
  "base-sepolia": "eip155:84532",
  polygon: "eip155:137",
  arbitrum: "eip155:42161",
  optimism: "eip155:10",
  avalanche: "eip155:43114",
};

// =============================================================================
// Capability Search
//
// Thin client over dexter-api's /api/x402gle/capability endpoint. The legacy
// substring ranker at /api/facilitator/marketplace/resources was retired —
// discovery now goes through a semantic vector search pipeline with synonym
// expansion, similarity floor filtering, strong/related tiering, and a
// cross-encoder LLM rerank on the top strong results.
//
// Emits a hybrid response shape: a flat `resources[]` array for OpenClaw
// renderers that pattern-match legacy field names, plus full tiered
// `strongResults`/`relatedResults` arrays with `tier`, `similarity`, and
// `why` fields for agents that want the semantic signals.
// =============================================================================

interface CapabilityResult {
  resourceId: string;
  resourceUrl: string;
  displayName: string | null;
  description: string | null;
  category: string | null;
  host: string | null;
  method: string;
  icon: string | null;
  pricing: { usdc: number | null; network: string | null; asset: string | null };
  verification: {
    status: string;
    paid: boolean;
    qualityScore: number | null;
    lastVerifiedAt: string | null;
  };
  usage: {
    totalSettlements: number;
    totalVolumeUsdc: number;
    lastSettlementAt: string | null;
  };
  gaming: { flags: string[]; suspicious: boolean };
  score: number;
  similarity: number;
  why: string;
  tier: "strong" | "related";
}

function formatPriceLabel(priceUsdc: number | null): string {
  if (priceUsdc == null) return "price on request";
  if (priceUsdc === 0) return "free";
  if (priceUsdc < 0.01) return `$${priceUsdc.toFixed(4)}`;
  return `$${priceUsdc.toFixed(2)}`;
}

function flattenResult(r: CapabilityResult): FlatSearchResource {
  return {
    resourceId: r.resourceId,
    name: r.displayName ?? r.resourceUrl,
    url: r.resourceUrl,
    method: r.method || "GET",
    price: formatPriceLabel(r.pricing.usdc),
    priceUsdc: r.pricing.usdc,
    network: r.pricing.network,
    description: r.description ?? "",
    category: r.category ?? "uncategorized",
    qualityScore: r.verification.qualityScore,
    verified: r.verification.status === "pass",
    verificationStatus: r.verification.status,
    totalCalls: r.usage.totalSettlements,
    totalVolumeUsdc: r.usage.totalVolumeUsdc,
    host: r.host,
    iconUrl: r.icon,
    gamingFlags: r.gaming.flags,
    gamingSuspicious: r.gaming.suspicious,
    tier: r.tier,
    similarity: Math.round(r.similarity * 1000) / 1000,
    why: r.why,
    score: r.score,
  };
}

async function capabilitySearch(
  query: string,
  options?: {
    limit?: number;
    unverified?: boolean;
    testnets?: boolean;
    rerank?: boolean;
    endpoint?: string;
  }
): Promise<{
  strongResults: FlatSearchResource[];
  relatedResults: FlatSearchResource[];
  resources: FlatSearchResource[];
  strongCount: number;
  relatedCount: number;
  topSimilarity: number | null;
  noMatchReason: "below_similarity_threshold" | "below_strong_threshold" | null;
  rerank: { enabled: boolean; applied: boolean; reason?: string };
  intent: { capabilityText: string; expandedCapabilityText?: string };
}> {
  const baseUrl = options?.endpoint || DEFAULT_CAPABILITY_URL;
  const params = new URLSearchParams();
  params.set("q", query);
  params.set("limit", String(Math.min(Math.max(options?.limit ?? 20, 1), 50)));
  if (options?.unverified) params.set("unverified", "true");
  if (options?.testnets) params.set("testnets", "true");
  if (options?.rerank === false) params.set("rerank", "false");

  const response = await fetch(`${baseUrl}?${params}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Capability search failed: ${response.status} ${body.slice(0, 400)}`
    );
  }

  const data = (await response.json()) as {
    ok?: boolean;
    error?: string;
    stage?: string;
    strongResults: CapabilityResult[];
    relatedResults: CapabilityResult[];
    strongCount: number;
    relatedCount: number;
    topSimilarity: number | null;
    noMatchReason: "below_similarity_threshold" | "below_strong_threshold" | null;
    rerank: { enabled: boolean; applied: boolean; reason?: string };
    intent: { capabilityText: string; expandedCapabilityText?: string };
  };

  if (!data.ok) {
    throw new Error(
      `Capability search error${data.stage ? ` at stage ${data.stage}` : ""}: ${data.error ?? "unknown"}`
    );
  }

  const strong = (data.strongResults || []).map(flattenResult);
  const related = (data.relatedResults || []).map(flattenResult);

  return {
    strongResults: strong,
    relatedResults: related,
    resources: [...strong, ...related],
    strongCount: data.strongCount,
    relatedCount: data.relatedCount,
    topSimilarity: data.topSimilarity,
    noMatchReason: data.noMatchReason,
    rerank: data.rerank,
    intent: data.intent,
  };
}

// =============================================================================
// x402 Fetch Client
// =============================================================================

function buildX402Fetch(config: PluginConfig): typeof fetch | null {
  if (!config.svmPrivateKey && !config.evmPrivateKey) return null;

  const opts: WrapFetchOptions = { verbose: false };

  if (config.svmPrivateKey) opts.walletPrivateKey = config.svmPrivateKey;
  if (config.evmPrivateKey) opts.evmPrivateKey = config.evmPrivateKey;
  if (config.facilitatorUrl) opts.facilitatorUrl = config.facilitatorUrl;
  if (config.defaultNetwork) {
    opts.preferredNetwork =
      NETWORK_TO_CAIP2[config.defaultNetwork] || config.defaultNetwork;
  }
  if (config.maxPaymentUSDC) {
    const [whole, fraction = ""] = config.maxPaymentUSDC.split(".");
    opts.maxAmountAtomic = `${whole}${(fraction + "000000").slice(0, 6)}`;
  }

  return wrapFetch(globalThis.fetch, opts);
}

// =============================================================================
// Plugin Entry
// =============================================================================

export default {
  id: "opendexter",
  name: "OpenDexter",
  description:
    "x402 marketplace access for OpenClaw agents. Search, price-check, and pay for paid APIs with USDC across Solana, Base, Polygon, Arbitrum, Optimism, and Avalanche.",

  register(api: any) {
    const raw = (api.pluginConfig || {}) as PluginConfig;

    // Merge plugin config with environment variable fallbacks.
    // This lets Pinata secrets (env vars) feed the plugin when the
    // plugin config UI isn't available.
    const config: PluginConfig = {
      svmPrivateKey: raw.svmPrivateKey || process.env.SVM_PRIVATE_KEY,
      evmPrivateKey: raw.evmPrivateKey || process.env.EVM_PRIVATE_KEY,
      defaultNetwork: raw.defaultNetwork || process.env.DEFAULT_NETWORK,
      maxPaymentUSDC: raw.maxPaymentUSDC || process.env.MAX_PAYMENT_USDC || "0.50",
      facilitatorUrl: raw.facilitatorUrl || process.env.FACILITATOR_URL,
      marketplaceUrl: raw.marketplaceUrl || process.env.MARKETPLACE_URL,
    };

    let cachedFetch: typeof fetch | null | undefined;

    const getClient = () => {
      if (cachedFetch !== undefined) return cachedFetch;
      cachedFetch = buildX402Fetch(config);
      return cachedFetch;
    };

    // ----- x402_search -----
    api.registerTool({
      name: "x402_search",
      description:
        "Semantic search over the OpenDexter x402 marketplace. Pass a natural-language query and get back two tiers: strong matches (high-confidence capability hits) and related matches (adjacent services that cleared the similarity floor). The ranker handles synonym expansion and alternate phrasings internally — just describe what you want. Use x402_fetch or x402_pay to call any result.",
      parameters: Type.Object({
        query: Type.String({
          description:
            'Natural-language description of the capability you want. e.g. "check wallet balance on Base", "generate an image", "ETH spot price feed". Do NOT pre-filter by chain or category — the search layer handles those semantically.',
        }),
        limit: Type.Optional(
          Type.Number({
            description:
              "Max results across strong + related tiers combined (1-50, default 20)",
          })
        ),
        unverified: Type.Optional(
          Type.Boolean({
            description: "Include unverified resources (default false)",
          })
        ),
        testnets: Type.Optional(
          Type.Boolean({
            description: "Include testnet-only resources (default false)",
          })
        ),
        rerank: Type.Optional(
          Type.Boolean({
            description:
              "Cross-encoder LLM rerank of top strong results (default true). Set false for deterministic order or lowest-latency path.",
          })
        ),
      }),

      async execute(_id: string, input: any) {
        const query = typeof input.query === "string" ? input.query.trim() : "";
        if (!query) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: false,
                  error: "query is required",
                }),
              },
            ],
          };
        }

        try {
          const result = await capabilitySearch(query, {
            limit: input.limit,
            unverified: input.unverified,
            testnets: input.testnets,
            rerank: input.rerank,
            endpoint: config.marketplaceUrl,
          });

          const searchMeta = {
            mode:
              result.strongCount > 0
                ? "direct"
                : result.relatedCount > 0
                  ? "related_only"
                  : "empty",
            reason: result.noMatchReason,
          };

          const tip =
            result.strongCount > 0
              ? "Use x402_fetch or x402_pay to call any of these endpoints. Strong matches are high-confidence; related matches are adjacent capabilities."
              : result.relatedCount > 0
                ? "No exact match. These are the closest related services — confirm with the user before calling."
                : "Nothing in the index matches this query yet. Try a broader phrasing.";

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    success: true,
                    count: result.resources.length,
                    resources: result.resources,
                    strongResults: result.strongResults,
                    relatedResults: result.relatedResults,
                    strongCount: result.strongCount,
                    relatedCount: result.relatedCount,
                    topSimilarity: result.topSimilarity,
                    noMatchReason: result.noMatchReason,
                    rerank: result.rerank,
                    intent: result.intent,
                    searchMeta,
                    source: "OpenDexter (https://dexter.cash)",
                    tip,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: false,
                  error:
                    error instanceof Error ? error.message : String(error),
                }),
              },
            ],
          };
        }
      },
    });

    // ----- x402_check -----
    api.registerTool({
      name: "x402_check",
      description:
        "Probe an x402 endpoint to see its pricing per chain without paying. Use before x402_fetch to show the user what a call will cost.",
      parameters: Type.Object({
        url: Type.String({ description: "The URL to check" }),
        method: Type.Optional(
          Type.String({ description: "HTTP method to probe (default: GET)" })
        ),
      }),

      async execute(_id: string, input: any) {
        const url = input.url;
        const method = (input.method || "GET").toUpperCase();

        try {
          const hasBody = ["POST", "PUT", "PATCH"].includes(method);
          const res = await fetch(url, {
            method,
            ...(hasBody
              ? { headers: { "Content-Type": "application/json" }, body: "{}" }
              : {}),
            signal: AbortSignal.timeout(15_000),
          });

          if (res.status === 401 || res.status === 403) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    error: true,
                    statusCode: res.status,
                    authRequired: true,
                    message:
                      "Provider authentication required before x402 payment.",
                  }),
                },
              ],
            };
          }

          if (res.status !== 402) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    requiresPayment: false,
                    statusCode: res.status,
                    free: res.ok,
                  }),
                },
              ],
            };
          }

          let body: Record<string, unknown> | null = null;
          try {
            body = (await res.json()) as Record<string, unknown>;
          } catch {
            // non-JSON 402 body
          }

          const accepts =
            (body?.accepts as Array<Record<string, unknown>>) || [];
          const paymentOptions = accepts.map((a) => {
            const amount = Number(a.amount || a.maxAmountRequired || 0);
            const decimals = Number(
              (a.extra as Record<string, unknown>)?.decimals ?? 6
            );
            return {
              price: amount / Math.pow(10, decimals),
              priceFormatted: `$${(amount / Math.pow(10, decimals)).toFixed(2)}`,
              network: a.network,
              scheme: a.scheme,
              asset: a.asset,
              payTo: a.payTo,
            };
          });

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    requiresPayment: true,
                    statusCode: 402,
                    x402Version: body?.x402Version ?? 2,
                    paymentOptions,
                    resource: body?.resource ?? null,
                    schema: accepts[0]?.outputSchema ?? null,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: true,
                  message:
                    error instanceof Error ? error.message : String(error),
                }),
              },
            ],
          };
        }
      },
    });

    // ----- Shared fetch+pay execution -----
    const executeFetch = async (input: Record<string, unknown>) => {
      const url = input.url as string;
      const method = ((input.method as string) || "GET").toUpperCase();

      const fetchClient = getClient();
      if (!fetchClient) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                error:
                  "No wallet configured. Set svmPrivateKey or evmPrivateKey in the OpenDexter plugin config.",
              }),
            },
          ],
        };
      }

      try {
        let requestUrl = url;
        let body: string | undefined;
        const requestHeaders: Record<string, string> = {
          Accept: "application/json",
          "User-Agent": "opendexter-plugin/1.0",
          ...((input.headers as Record<string, string>) || {}),
        };

        if (
          method === "GET" &&
          input.params &&
          typeof input.params === "object"
        ) {
          const urlObj = new URL(url);
          for (const [key, value] of Object.entries(
            input.params as Record<string, unknown>
          )) {
            if (value !== undefined && value !== null) {
              urlObj.searchParams.set(key, String(value));
            }
          }
          requestUrl = urlObj.toString();
        } else if (input.params !== undefined && input.params !== null) {
          body =
            typeof input.params === "string"
              ? input.params
              : JSON.stringify(input.params);
          if (!requestHeaders["Content-Type"]) {
            requestHeaders["Content-Type"] = "application/json";
          }
        }

        const response = await fetchClient(requestUrl, {
          method,
          headers: requestHeaders,
          body,
          signal: AbortSignal.timeout(30_000),
        });

        const contentType = response.headers.get("content-type") || "";
        let data: unknown;
        if (contentType.includes("application/json")) {
          data = await response.json().catch(() => null);
        } else if (contentType.startsWith("text/")) {
          data = await response.text();
        } else {
          data = `[Binary: ${contentType}, ${response.headers.get("content-length") || "unknown"} bytes]`;
        }

        let paidUsdc: string | null = null;
        const paymentHeader =
          response.headers.get("PAYMENT-RESPONSE") ||
          response.headers.get("x-payment-response");
        if (paymentHeader) {
          try {
            const payment = JSON.parse(atob(paymentHeader));
            const rawAmount =
              payment.amount || payment.paidAmount || payment.value;
            if (rawAmount) {
              paidUsdc = (Number(rawAmount) / 1_000_000).toFixed(6);
            }
          } catch {
            // ignore malformed receipt
          }
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: response.ok,
                  statusCode: response.status,
                  data,
                  ...(paidUsdc ? { paidUsdc: `$${paidUsdc}` } : {}),
                  network: config.defaultNetwork || "auto",
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);

        if (msg.includes("amount_exceeds_max")) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: false,
                  error: `Payment exceeds configured max of $${config.maxPaymentUSDC || "0.50"} USDC. Adjust maxPaymentUSDC in plugin config.`,
                  blocked: true,
                }),
              },
            ],
          };
        }

        if (msg.includes("insufficient_balance")) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: false,
                  error: "Insufficient USDC balance.",
                  help: "Fund the wallet with USDC on the appropriate network.",
                }),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: false, error: msg }),
            },
          ],
        };
      }
    };

    const fetchParams = Type.Object({
      url: Type.String({ description: "The x402 endpoint URL to call" }),
      method: Type.Optional(
        Type.String({ description: "HTTP method (default: GET)" })
      ),
      params: Type.Optional(
        Type.Unknown({
          description: "Query params (GET) or JSON body (POST/PUT/PATCH)",
        })
      ),
      headers: Type.Optional(
        Type.Unknown({ description: "Custom request headers" })
      ),
    });

    // ----- x402_fetch -----
    api.registerTool({
      name: "x402_fetch",
      description:
        "Call any x402-protected API with automatic USDC payment. Returns the API response and payment receipt.",
      parameters: fetchParams,
      async execute(_id: string, input: any) {
        return executeFetch(input);
      },
    });

    // ----- x402_pay -----
    api.registerTool({
      name: "x402_pay",
      description:
        "Alias for x402_fetch. Call any x402 API with automatic payment.",
      parameters: fetchParams,
      async execute(_id: string, input: any) {
        return executeFetch(input);
      },
    });

    // ----- x402_wallet -----
    api.registerTool({
      name: "x402_wallet",
      description:
        "Show wallet configuration: active networks, spending limit, facilitator. Use when the user asks about their wallet setup.",
      parameters: Type.Object({}),

      async execute() {
        if (!config.svmPrivateKey && !config.evmPrivateKey) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  configured: false,
                  error: "No wallet configured.",
                  help: "Set svmPrivateKey or evmPrivateKey in the OpenDexter plugin config.",
                }),
              },
            ],
          };
        }

        const wallets: Array<{
          type: string;
          networks: string[];
          configured: boolean;
        }> = [];

        if (config.svmPrivateKey) {
          wallets.push({
            type: "solana",
            networks: ["solana"],
            configured: true,
          });
        }

        if (config.evmPrivateKey) {
          wallets.push({
            type: "evm",
            networks: ["base", "polygon", "arbitrum", "optimism", "avalanche"],
            configured: true,
          });
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  configured: true,
                  wallets,
                  defaultNetwork:
                    config.defaultNetwork || "auto",
                  maxPaymentPerCall: `$${config.maxPaymentUSDC || "0.50"} USDC`,
                  facilitator:
                    config.facilitatorUrl || DEFAULT_FACILITATOR_URL,
                },
                null,
                2
              ),
            },
          ],
        };
      },
    });

    api.logger.info("OpenDexter plugin registered");
    api.logger.info(
      `  Wallet: ${config.svmPrivateKey || config.evmPrivateKey ? "configured" : "not configured"}`
    );
    api.logger.info(
      `  Capability search: ${config.marketplaceUrl || DEFAULT_CAPABILITY_URL}`
    );
  },
};
