# SealedBidProcurement

A GenLayer Intelligent Contract for commit-reveal sealed-bid procurement auctions with dual-LLM technical evidence evaluation (evidence entailment + specification compliance) and permissionless Vickrey second-price settlement.

**Deployed StudioNet (Chain ID 61999):** [`0x5AA77e0869720E009B39f30D6b523BDeEFBCF1ba`](https://explorer-studio.genlayer.com/address/0x5AA77e0869720E009B39f30D6b523BDeEFBCF1ba)  
**Probe Contract:** [`0xab2f00925D0Fe4c08bBCBC764e88526D9511Fdb1`](https://explorer-studio.genlayer.com/address/0xab2f00925D0Fe4c08bBCBC764e88526D9511Fdb1)  
**Contract Source Commit:** [`1108c56`](https://github.com/khezzed/SealedBidProcurement/commit/1108c56ea9f70058e196926cf9910dc3eec09cbc) | **Git Blob:** `568dd587a255a912fcc393b2d36249323dd9bc92` | **SHA-256:** `629e926aec1580b3857f1d667624f035dc31ad7e41489bb1ba36ddc7003e55f1`  
**Manifest & Proof:** [`deploy/manifest.json`](deploy/manifest.json) (100% byte-for-byte on-chain equality verified)

### Finalized Live StudioNet Demo (Tender 3, 14/14 Steps)

| Step | Method | Description | Outcome | StudioNet Explorer Tx |
|---|---|---|---|---|
| **S1** | `open_tender` | Buyer opens HSM procurement (reserve 500, 240s/480s) | OPENED:TENDER_3 | [`0xbf526bc2...`](https://explorer-studio.genlayer.com/tx/0xbf526bc292e73059b7810d63d48220ecb67f5e2af3d762306a05e6f7287f700d) |
| **S2** | `commit_bid` | Vendor B commits lowball bid hash | COMMITTED:VENDOR_B | [`0xd835e3f3...`](https://explorer-studio.genlayer.com/tx/0xd835e3f330c925388b2e252dc4d6b56192746f2b5b1640055381b8cf5d843271) |
| **S3** | `commit_bid` | Vendor A commits compliant bid hash | COMMITTED:VENDOR_A | [`0x74147689...`](https://explorer-studio.genlayer.com/tx/0x74147689ad2e1c6fab50a5a82af21901b7685f79f78fa6920142c7b213a21177) |
| **S4** | `commit_bid` | Vendor C commits compliant bid hash | COMMITTED:VENDOR_C | [`0x3cf777fd...`](https://explorer-studio.genlayer.com/tx/0x3cf777fddc151f5949021f524fb9e488abd8848d34486dbc22b30a19c374f647) |
| **X1** | `commit_bid` | [Expected Failure] Duplicate commitment blocked | UserError: ALREADY_COMMITTED | [`0x668052c7...`](https://explorer-studio.genlayer.com/tx/0x668052c7c9748fdbdb08acd5320c3e4b53a8a0d19387cf0b294b26ba1c15975c) |
| **X2** | `reveal_and_evaluate` | [Expected Failure] Premature reveal before commit deadline | UserError: COMMIT_PHASE_NOT_ENDED | [`0x01226109...`](https://explorer-studio.genlayer.com/tx/0x01226109db4cdecbea5b381db11a8cbe0b64aea82a9c45981cb0845a81efc9bf) |
| **X3** | `reveal_and_evaluate` | [Expected Failure] Tampered price 190 blocked | UserError: COMMITMENT_MISMATCH | [`0x7461a06b...`](https://explorer-studio.genlayer.com/tx/0x7461a06bde69d3056b230664122ef176ec0018e3b15dbc4930a98666cb1f5bd3) |
| **S5** | `reveal_and_evaluate` | Vendor B reveals lowball 120 (LLM spec disqualifies) | REVEALED:INELIGIBLE:PRICE_120 | [`0x236277f5...`](https://explorer-studio.genlayer.com/tx/0x236277f57fd25392c883f3455ea218c401fbacfe3d09fded4235c37b7f58560f) |
| **S6** | `reveal_and_evaluate` | Vendor A reveals compliant 210 (LLM verifies ELIGIBLE) | REVEALED:ELIGIBLE:PRICE_210 | [`0x9c69e037...`](https://explorer-studio.genlayer.com/tx/0x9c69e037842f15d3aaf393b8709fae8fb79b198ce1cc64a0e44d73791f0b1c93) |
| **S7** | `reveal_and_evaluate` | Vendor C reveals compliant 340 (LLM verifies ELIGIBLE) | REVEALED:ELIGIBLE:PRICE_340 | [`0xc53c8856...`](https://explorer-studio.genlayer.com/tx/0xc53c885672cb9d48958b09f4a39a80c62ad9be36722543b0056a05e689408186) |
| **X4** | `reveal_and_evaluate` | [Expected Failure] Duplicate reveal blocked | UserError: ALREADY_REVEALED | [`0x7b42a521...`](https://explorer-studio.genlayer.com/tx/0x7b42a52185ab45784966ade7bf1fd5f8956b6affad2ba8f08c53d4a874149d28) |
| **X5** | `settle_tender` | [Expected Failure] Premature settlement before reveal deadline | UserError: REVEAL_PHASE_NOT_ENDED | [`0x62eb064d...`](https://explorer-studio.genlayer.com/tx/0x62eb064ded954eadcf36e3dc1012b9041d1be3d3c35e3a1b8426049d9881784b) |
| **S8** | `settle_tender` | Permissionless Vickrey settlement awards Vendor A at 340 | AWARDED:WINNER_0x3C82...:CLEARING_340 | [`0x307682af...`](https://explorer-studio.genlayer.com/tx/0x307682af7adba04400d2bf48cbdb1cd94b7f57e979b91c8ea6df66f33609d6c4) |
| **X6** | `settle_tender` | [Expected Failure] Double settlement blocked | UserError: TENDER_ALREADY_SETTLED | [`0x20f9297d...`](https://explorer-studio.genlayer.com/tx/0x20f9297dc876263b59a9653102b8f91d62f2a812b018aa2bf7f54dc44e0a2168) |

**Local Testing:** Run `pytest tests -v` (30 unit tests pass locally in ~0.5s).  
**Honest Scope:** Demonstrates two-phase commit-reveal procurement auctions, LLM specification compliance evaluation, and Vickrey second-price clearing; incomplete pre-restart runs are archived honestly in `deploy/manifest.json` under `interrupted_by_restart_v1`.
