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

type MarketplaceResource = {
  name: string;
  url: string;
  method: string;
  price: string;
  network: string | null;
  description: string;
  category: string;
  qualityScore: number | null;
  verified: boolean;
  totalCalls: number;
  totalVolume: string | null;
  seller: string | null;
  sellerReputation: number | null;
};

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_FACILITATOR_URL = "https://x402.dexter.cash";
const DEFAULT_MARKETPLACE_URL =
  "https://x402.dexter.cash/api/facilitator/marketplace/resources";

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
// Marketplace Search
// =============================================================================

async function searchMarketplace(
  query?: string,
  options?: {
    network?: string;
    verified?: boolean;
    category?: string;
    maxPriceUsdc?: number;
    sort?: string;
    limit?: number;
    marketplaceUrl?: string;
  }
): Promise<{ resources: MarketplaceResource[]; total: number }> {
  const baseUrl = options?.marketplaceUrl || DEFAULT_MARKETPLACE_URL;
  const params = new URLSearchParams();

  if (query) params.set("search", query);
  if (options?.network) params.set("network", options.network);
  if (options?.verified) params.set("verified", "true");
  if (options?.category) params.set("category", options.category);
  if (options?.maxPriceUsdc != null)
    params.set("maxPrice", String(options.maxPriceUsdc));
  params.set("sort", options?.sort || "marketplace");
  params.set("order", "desc");
  params.set("limit", String(Math.min(options?.limit || 20, 50)));

  const response = await fetch(`${baseUrl}?${params}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(
      `Marketplace search failed: ${response.status} ${response.statusText}`
    );
  }

  const data = (await response.json()) as {
    ok?: boolean;
    resources?: Array<Record<string, unknown>>;
    total?: number;
  };

  const resources = (data.resources || []).map(
    (r: Record<string, unknown>) => ({
      name: (r.displayName as string) || (r.resourceUrl as string),
      url: r.resourceUrl as string,
      method: (r.method as string) || "GET",
      price:
        (r.priceLabel as string) ||
        (r.priceUsdc != null ? `$${Number(r.priceUsdc).toFixed(2)}` : "free"),
      network: (r.priceNetwork as string) || null,
      description: (r.description as string) || "",
      category: (r.category as string) || "uncategorized",
      qualityScore: (r.qualityScore as number) ?? null,
      verified: r.verificationStatus === "pass",
      totalCalls: (r.totalSettlements as number) ?? 0,
      totalVolume:
        r.totalVolumeUsdc != null
          ? `$${Number(r.totalVolumeUsdc).toLocaleString()}`
          : null,
      seller:
        ((r.seller as Record<string, unknown>)?.displayName as string) || null,
      sellerReputation: (r.reputationScore as number) ?? null,
    })
  );

  return { resources, total: data.total || resources.length };
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
        "Search the OpenDexter marketplace for paid APIs. Returns quality-ranked results with pricing, verification status, and seller reputation.",
      parameters: Type.Object({
        query: Type.Optional(
          Type.String({
            description:
              'Search query (e.g. "token analytics", "sentiment", "image generation")',
          })
        ),
        network: Type.Optional(
          Type.String({
            description:
              "Filter by network: solana, base, polygon, arbitrum, optimism, avalanche",
          })
        ),
        verified: Type.Optional(
          Type.Boolean({ description: "Only return quality-verified endpoints" })
        ),
        category: Type.Optional(
          Type.String({ description: "Filter by category" })
        ),
        maxPriceUsdc: Type.Optional(
          Type.Number({ description: "Maximum price per call in USDC" })
        ),
        sort: Type.Optional(
          Type.String({
            description:
              "Sort: marketplace (default), relevance, quality_score, settlements, volume, recent",
          })
        ),
        limit: Type.Optional(
          Type.Number({ description: "Max results (default 20, max 50)" })
        ),
      }),

      async execute(_id: string, input: any) {
        try {
          const result = await searchMarketplace(input.query, {
            network: input.network,
            verified: input.verified,
            category: input.category,
            maxPriceUsdc: input.maxPriceUsdc,
            sort: input.sort,
            limit: Math.min(input.limit || 20, 50),
            marketplaceUrl: config.marketplaceUrl,
          });

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    success: true,
                    total: result.total,
                    showing: result.resources.length,
                    resources: result.resources,
                    source: "OpenDexter (https://dexter.cash)",
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
      `  Marketplace: ${config.marketplaceUrl || DEFAULT_MARKETPLACE_URL}`
    );
  },
};
