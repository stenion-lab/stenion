## GET /api/v1/coverage

Protocols and markets Stenion has assessed and deliberately does not score. This is a separate,
unranked contract: an entry here is a coverage decision, never a failed run or a low score.

**Request**

```bash
curl https://stenion.vercel.app/api/v1/coverage
```

**Response** `200 OK`

> The first entry is shown below for readability. The live response returned 4 entries in the
> `coverage` array; this object is verbatim from a production `curl`.

```json
{
  "coverage": [
    {
      "id": "templar",
      "name": "Templar",
      "status": "off-chain-state",
      "logo": null,
      "links": {
        "site": null,
        "docs": null
      },
      "contractId": null,
      "summary": "A NEAR-based protocol whose reserves, balances and positions live on NEAR — the only contract it runs on Soroban is a price oracle.",
      "reason": [
        "Templar is a NEAR-based chain-abstraction protocol — it calls its product “Cypher Lending” — and its lending market state lives on NEAR, not on Stellar. Reserves, supply and borrow balances, utilization and collateral positions are all read through NEAR RPC. Stellar’s role is as a wallet and collateral entry point via NEAR’s MPC signing, not as the ledger the lending market runs on.",
        "The only native-Soroban contract Templar ships is a price oracle. That is one of the five factors Stenion scores; the other four are on another chain. An adapter faithful to what Templar actually is would have to read NEAR, and Stenion’s adapters read trustless Stellar infrastructure and nothing else — that rule is the pitch rather than an implementation detail, so bending it for one protocol would quietly change what every other score means.",
        "This is a decision about where the data lives, not a judgment about Templar. It could be represented only if Stenion’s model expanded to read another chain, which ROADMAP.md keeps explicitly out of scope."
      ],
      "verify": "Follow Templar’s own documentation for where lending state is held, then confirm it against the chain: the Soroban contract it publishes on Stellar exposes an oracle interface (price reads), with no reserve, supply/borrow or position storage. There is no Soroban contract to call get_reserves_list, or any equivalent, against.",
      "asOf": null
    }
  ]
}
```

| Field        | Type                 | Notes                                                                                                             |
| ------------ | -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `id`         | string               | Stable, case-sensitive coverage identifier; also the path segment on `/coverage/<id>`.                            |
| `name`       | string               | Display name.                                                                                                     |
| `status`     | string               | Machine-readable coverage category. New categories may be added on `v1`; existing values are not renamed on `v1`. |
| `logo`       | string or null       | Root-relative self-hosted mark, or `null`.                                                                        |
| `links`      | object               | The protocol's verified `site` and `docs`, each string or `null`.                                                 |
| `contractId` | string or null       | Full Soroban address only when one was recorded; otherwise `null`.                                                |
| `summary`    | string               | One-sentence coverage summary.                                                                                    |
| `reason`     | string[]             | Protocol-specific evidence and reasoning. Quoted measurements remain text, not a numeric score.                   |
| `verify`     | string               | How an integrator or reader can independently check the decision.                                                 |
| `asOf`       | `YYYY-MM-DD` or null | Date of a measurement-backed reason. `null` means the decision is structural or no dated check is claimed.        |

There is deliberately **no `safetyScore` key and no JSON numeric value anywhere in this
response**. Identifiers, dates, and evidence strings can contain digits; none is a value a client
could mistake for a score. The full evidence ships in the list, so there is no separate
`GET /api/v1/coverage/:id` endpoint.

The route reads the live leaderboard only to apply the same self-healing dedupe as the registry. A
protocol that has become scorable cannot appear in both responses. `GET /api/v1/protocols` is
unchanged byte-for-byte.

---

## Not every entry is a protocol

Some entries are **individual markets running another protocol's contracts**, not protocols in their
own right. The YieldBlox entry (`yieldblox`) is one: it is a DAO-managed pool on Blend V2, running
Blend's pool contract byte-for-byte, and Stenion scores it with the same adapter it uses for Blend's
own pool.

Such an entry carries a non-null `deployedOn` on **both** endpoints — verbatim from the
`yieldblox` entry in the leaderboard capture above:

```json
"deployedOn": {
  "host": "Blend",
  "label": "Blend V2 pool"
}
```

| Field   | Type   | Notes                                                                               |
| ------- | ------ | ----------------------------------------------------------------------------------- |
| `host`  | string | The host protocol's **display name**, e.g. `"Blend"`. Not an `id`, and not a link.  |
| `label` | string | Short label naming the deployment, e.g. `"Blend V2 pool"`. Safe to render verbatim. |

`null` means the entry runs on its own contracts. It never means "unknown" — we do not register an
entry without knowing which.

**If you display protocol names, display this beside them.** Not a style preference: without it your
users read a list of markets as a list of protocols, which is a claim about the ecosystem that isn't
true. Rendering `label` verbatim next to the name is enough.

**`host` is deliberately not a protocol id and links to nothing.** Stenion's `blend` entry is itself
one Blend market, so pointing at it would say this pool runs on _that entry_ rather than on Blend's
contract. If you want the host's own entry, you are looking for a relationship this API does not
assert.

**Each such entry is scored independently, on its own on-chain state.** Sharing contract code is not
sharing a score: `deployedOn` markets are ranked on their own reserves, oracle configuration and
admin like any other entry, and the two live Blend pools currently differ by 30 points. Do not infer
one entry's risk from its host's.

---
