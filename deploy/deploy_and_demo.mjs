import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createClient, chains, createAccount, generatePrivateKey } from 'genlayer-js';

// Setup custom browser User-Agent header across all fetch calls
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const origFetch = globalThis.fetch;
globalThis.fetch = (url, init = {}) => {
  const headers = new Headers(init?.headers || {});
  if (!headers.has('User-Agent')) {
    headers.set('User-Agent', BROWSER_UA);
  }
  return origFetch(url, { ...init, headers });
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const STATE_FILE = path.join(ROOT_DIR, 'deploy', 'state.json');
const MANIFEST_FILE = path.join(ROOT_DIR, 'deploy', 'manifest.json');

const SOURCE_COMMIT = '1108c56ea9f70058e196926cf9910dc3eec09cbc';
const GIT_BLOB_HASH = '568dd587a255a912fcc393b2d36249323dd9bc92';
const EXPECTED_LOCAL_SHA256 = '629e926aec1580b3857f1d667624f035dc31ad7e41489bb1ba36ddc7003e55f1';
const RUNNER_HASH = 'py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6';

const BASE_EVIDENCE_URL = `https://raw.githubusercontent.com/khezzed/SealedBidProcurement/${SOURCE_COMMIT}/evidence`;
const e1_url = `${BASE_EVIDENCE_URL}/e1_vendor_a_hsm_datasheet.txt`;
const e2_url = `${BASE_EVIDENCE_URL}/e2_vendor_b_lowball_datasheet.txt`;
const e3_url = `${BASE_EVIDENCE_URL}/e3_vendor_c_hsm_datasheet.txt`;
const e4_url = `${BASE_EVIDENCE_URL}/e4_unrelated_catering_menu.txt`;

const EVIDENCE_INFO = [
  {
    file: 'evidence/e1_vendor_a_hsm_datasheet.txt',
    size: 250,
    sha256: '46621336c20d899c37bfc576baf5419e52abacd47244a3f708b6cb2f8e0014af',
    url: e1_url
  },
  {
    file: 'evidence/e2_vendor_b_lowball_datasheet.txt',
    size: 266,
    sha256: '4a6eb9235bf766a4ec0882ae68d9799a455b3307acfe20726ce35ce1167d9015',
    url: e2_url
  },
  {
    file: 'evidence/e3_vendor_c_hsm_datasheet.txt',
    size: 244,
    sha256: '756f48dc69a54190d56a2bd40c97ce842a86260f04eab6d009906fe1c8a6fc27',
    url: e3_url
  },
  {
    file: 'evidence/e4_unrelated_catering_menu.txt',
    size: 133,
    sha256: '537058a65fcacb58a97645a6c370c155f446cb0964fc769028b4e2ddff49182f',
    url: e4_url
  }
];

function sha256(content) {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

function computeCommitmentHash(tenderId, vendor, price, evidenceUrl, technicalSummary, salt) {
  const preimage = [
    Number(tenderId),
    String(vendor).trim().toLowerCase(),
    Number(price),
    String(evidenceUrl),
    String(technicalSummary),
    String(salt)
  ].join('|');
  return crypto.createHash('sha256').update(preimage, 'utf-8').digest('hex');
}

function normalizeReturn(val) {
  if (typeof val === 'string') {
    let s = val.trim();
    if (s.startsWith('"') && s.endsWith('"')) {
      try {
        return JSON.parse(s);
      } catch {
        return s.slice(1, -1);
      }
    }
    return s;
  }
  return val;
}

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    } catch {
      return {};
    }
  }
  return {};
}

function saveState(patch) {
  const current = loadState();
  const updated = { ...current, ...patch, updatedAt: new Date().toISOString() };
  fs.writeFileSync(STATE_FILE, JSON.stringify(updated, null, 2), 'utf-8');
  return updated;
}

function createStudioClient(account) {
  return createClient({
    chain: {
      ...chains.studionet,
      rpcUrls: {
        default: {
          http: ['https://studio.genlayer.com/api']
        }
      }
    },
    account
  });
}

async function waitForReceipt(client, txHash, { maxAttempts = 120, intervalMs = 2500, expectSuccess = true } = {}) {
  console.log(`[POLL] Waiting for tx ${txHash} (expectSuccess=${expectSuccess})...`);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await new Promise(r => setTimeout(r, attempt === 1 ? 2000 : intervalMs));
    try {
      const tx = await client.getTransaction({ hash: txHash });
      const statusName = tx.statusName || (tx.consensus_history?.current_status_changes?.includes('FINALIZED') ? 'FINALIZED' : 'PENDING');
      const resultName = tx.result_name || 'UNKNOWN';
      const lr = tx.consensus_data?.leader_receipt?.[0];
      const execResult = lr?.execution_result || 'PENDING';
      const rawPayload = lr?.result?.payload?.readable ?? lr?.result?.payload ?? '';
      const returnPayload = normalizeReturn(rawPayload);
      const stderr = lr?.genvm_result?.stderr || '';
      const votes = tx.consensus_data?.votes || {};

      console.log(`  [Attempt ${attempt}/${maxAttempts}] status=${statusName} result=${resultName} GenVM=${execResult}`);

      if (statusName === 'FINALIZED') {
        const contractAddress = tx.to_address || tx.contract_address || (tx.data && tx.data.contract_address);

        if (expectSuccess && execResult !== 'SUCCESS') {
          throw new Error(`Transaction ${txHash} finalized with GenVM ${execResult} (expected SUCCESS). stderr: ${stderr} payload: ${JSON.stringify(returnPayload)}`);
        }

        return {
          finalized: true,
          status: statusName,
          result: resultName,
          executionResult: execResult,
          returnReadable: returnPayload,
          stderr,
          votes,
          contractAddress,
          tx
        };
      }
    } catch (err) {
      if (err.message && err.message.includes('finalized with GenVM')) {
        throw err;
      }
      console.warn(`  [Poll attempt ${attempt} warning]: ${err.message || err}`);
    }
  }
  throw new Error(`Transaction ${txHash} did not finalize in ${(maxAttempts * intervalMs) / 1000} seconds`);
}

async function readContractWithRetry(client, { address, functionName, args = [] }, retries = 6, delayMs = 2000) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await client.readContract({ address, functionName, args });
    } catch (err) {
      lastErr = err;
      console.warn(`  [readContract ${functionName} attempt ${attempt} warning]: ${err.message || err}`);
      await new Promise(r => setTimeout(r, delayMs * attempt));
    }
  }
  throw lastErr;
}

async function safeWrite(client, { address, functionName, args = [], value = 0n, expectSuccess = true }) {
  let txHash = null;
  let receipt = null;
  let clientError = null;

  try {
    txHash = await client.writeContract({
      address,
      functionName,
      args,
      value
    });
    console.log(`  -> writeContract ${functionName} sent, txHash: ${txHash}`);
  } catch (err) {
    clientError = err;
    console.log(`  -> writeContract ${functionName} direct client error: ${err.message || err}`);
  }

  if (txHash) {
    receipt = await waitForReceipt(client, txHash, { expectSuccess });
  }

  return { txHash, receipt, clientError };
}

async function main() {
  console.log('===============================================================');
  console.log('  SealedBidProcurement: StudioNet Deploy & Live Demo           ');
  console.log('  Contract Commit: ' + SOURCE_COMMIT);
  console.log('  Blob: ' + GIT_BLOB_HASH);
  console.log('===============================================================');

  let state = loadState();

  // Initialize accounts if not present (never commit or log private keys)
  if (!state.buyerPrivateKey || !state.vendorAPrivateKey || !state.vendorBPrivateKey || !state.vendorCPrivateKey) {
    console.log('Generating fresh private keys for Buyer and 3 Vendors...');
    const buyerKey = state.buyerPrivateKey || generatePrivateKey();
    const vendorAKey = state.vendorAPrivateKey || generatePrivateKey();
    const vendorBKey = state.vendorBPrivateKey || generatePrivateKey();
    const vendorCKey = state.vendorCPrivateKey || generatePrivateKey();
    state = saveState({
      buyerPrivateKey: buyerKey,
      vendorAPrivateKey: vendorAKey,
      vendorBPrivateKey: vendorBKey,
      vendorCPrivateKey: vendorCKey
    });
  }

  const buyerAccount = createAccount(state.buyerPrivateKey);
  const vendorAAccount = createAccount(state.vendorAPrivateKey);
  const vendorBAccount = createAccount(state.vendorBPrivateKey);
  const vendorCAccount = createAccount(state.vendorCPrivateKey);

  console.log(`Buyer (Deployer) : ${buyerAccount.address}`);
  console.log(`Vendor A         : ${vendorAAccount.address}`);
  console.log(`Vendor B (Lowball): ${vendorBAccount.address}`);
  console.log(`Vendor C         : ${vendorCAccount.address}`);

  const clientBuyer = createStudioClient(buyerAccount);
  const clientVendorA = createStudioClient(vendorAAccount);
  const clientVendorB = createStudioClient(vendorBAccount);
  const clientVendorC = createStudioClient(vendorCAccount);

  const history = state.history || [];
  let onChainSha256 = state.onChainSha256 || '';
  let blobEquality = state.blobEquality || false;

  let tenderId = state.tenderId || 3; // Tender 3 for clean live demo

  function updateManifest() {
    const finalState = loadState();
    const finalHistory = finalState.history || [];
    const finalTenderRaw = finalHistory.find(h => h.step === 'S8')?.readBack || finalHistory.find(h => h.step === 'S1')?.readBack || {};

    const manifest = {
      projectName: 'SealedBidProcurement',
      description: 'Two-phase commit-reveal procurement auction Intelligent Contract on GenLayer StudioNet with dual-LLM entailment and specification verification and Vickrey second-price settlement',
      sourceCommitSha: SOURCE_COMMIT,
      contractPath: 'contracts/sealed_bid_procurement.py',
      gitBlobHash: GIT_BLOB_HASH,
      localContractSha256: EXPECTED_LOCAL_SHA256,
      deployedCodeSha256: onChainSha256,
      blobEqualityResult: blobEquality ? 'MATCH (100% byte-for-byte)' : (onChainSha256 ? 'MISMATCH' : 'PENDING'),
      runnerHash: RUNNER_HASH,
      environment: 'StudioNet',
      network: 'studionet',
      rpcUrl: 'https://studio.genlayer.com/api',
      accounts: {
        buyer: {
          role: 'Procurement Authority / Deployer',
          address: buyerAccount.address
        },
        vendorA: {
          role: 'Vendor A (Compliant, Price 210, Winner)',
          address: vendorAAccount.address
        },
        vendorB: {
          role: 'Vendor B (Lowball Non-Compliant, Price 120, Ineligible)',
          address: vendorBAccount.address
        },
        vendorC: {
          role: 'Vendor C (Compliant, Price 340, Second Price Clearer)',
          address: vendorCAccount.address
        }
      },
      probeContract: {
        codePath: 'deploy/probe.py',
        runnerHash: RUNNER_HASH,
        address: probeAddress || state.probeAddress || '',
        deployTx: probeDeployTx || state.probeDeployTx || '',
        setTx: probeSetTx || state.probeSetTx || '',
        verifiedValue: probeVal || state.probeVal || ''
      },
      mainContract: {
        address: mainAddress || state.mainAddress || '',
        deployTx: mainDeployTx || state.mainDeployTx || ''
      },
      evidenceFiles: EVIDENCE_INFO,
      interrupted_by_restart_v1: state.interrupted_by_restart_v1 || null,
      demoTender: {
        tenderId,
        title: 'Production HSM Cluster Procurement',
        reservePrice: 500,
        commitDuration: 240,
        revealDuration: 480
      },
      transactions: finalHistory,
      finalTenderState: finalTenderRaw
    };

    fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2), 'utf-8');
    console.log(`Manifest updated: ${MANIFEST_FILE}`);
  }

  function recordStep(item) {
    const idx = history.findIndex(h => h.step === item.step);
    if (idx >= 0) {
      history[idx] = item;
    } else {
      history.push(item);
    }
    saveState({ history });
    updateManifest();
    console.log(`  [RECORDED STEP ${item.step}] ${item.method} | Hash: ${item.hash || 'N/A'} | Status: ${item.status} | Exec: ${item.executionResult}`);
  }

  function getStep(stepId) {
    return history.find(t => String(t.step) === String(stepId));
  }

  // ---------------------------------------------------------------------------
  // STEP B: PROBE CONTRACT VERIFICATION
  // ---------------------------------------------------------------------------
  console.log('\n--- STEP B: PROBE CONTRACT VERIFICATION ---');
  let probeAddress = state.probeAddress;
  let probeDeployTx = state.probeDeployTx;
  let probeSetTx = state.probeSetTx;
  let probeVal = state.probeVal;

  if (!probeAddress) {
    const probePath = path.join(ROOT_DIR, 'deploy', 'probe.py');
    const probeCode = fs.readFileSync(probePath, 'utf-8');
    console.log(`Deploying probe.py (${probeCode.length} bytes)...`);
    probeDeployTx = await clientBuyer.deployContract({ code: probeCode });
    console.log(`Probe Deploy Tx: ${probeDeployTx}`);
    const probeReceipt = await waitForReceipt(clientBuyer, probeDeployTx, { expectSuccess: true });
    probeAddress = probeReceipt.contractAddress;
    saveState({ probeAddress, probeDeployTx });
    console.log(`Probe contract finalized at: ${probeAddress}`);

    console.log('Writing on Probe: set_val("probe_ok")...');
    const setRes = await safeWrite(clientBuyer, {
      address: probeAddress,
      functionName: 'set_val',
      args: ['probe_ok'],
      expectSuccess: true
    });
    probeSetTx = setRes.txHash;
    saveState({ probeSetTx });

    probeVal = await readContractWithRetry(clientBuyer, {
      address: probeAddress,
      functionName: 'get_val',
      args: []
    });
    saveState({ probeVal });
    console.log(`Probe readback get_val: "${probeVal}"`);
    if (probeVal !== 'probe_ok') {
      throw new Error(`Probe check failed: expected 'probe_ok', got '${probeVal}'`);
    }
    console.log('[PASS] Probe verified on StudioNet!');
  } else {
    console.log(`[SKIP] Probe already deployed at: ${probeAddress} (verified value: ${probeVal})`);
  }

  // ---------------------------------------------------------------------------
  // STEP C: DEPLOY SealedBidProcurement & VERIFY BLOB EQUALITY
  // ---------------------------------------------------------------------------
  console.log('\n--- STEP C: DEPLOY SealedBidProcurement & VERIFY BLOB EQUALITY ---');
  let mainAddress = state.mainAddress;
  let mainDeployTx = state.mainDeployTx;

  const mainPath = path.join(ROOT_DIR, 'contracts', 'sealed_bid_procurement.py');
  const mainCode = fs.readFileSync(mainPath, 'utf-8');
  const localSha256 = sha256(mainCode);
  console.log(`Local contract path    : ${mainPath}`);
  console.log(`Local contract size    : ${mainCode.length} bytes`);
  console.log(`Git blob hash (sha1)   : ${GIT_BLOB_HASH}`);
  console.log(`Local source sha256    : ${localSha256}`);

  if (localSha256 !== EXPECTED_LOCAL_SHA256) {
    throw new Error(`Local source sha256 mismatch! Expected ${EXPECTED_LOCAL_SHA256}, got ${localSha256}`);
  }

  if (!mainAddress) {
    console.log(`Deploying SealedBidProcurement (${mainCode.length} bytes)...`);
    mainDeployTx = await clientBuyer.deployContract({ code: mainCode });
    console.log(`Main Deploy Tx: ${mainDeployTx}`);
    const mainReceipt = await waitForReceipt(clientBuyer, mainDeployTx, { expectSuccess: true });
    mainAddress = mainReceipt.contractAddress;
    console.log(`Main Contract Finalized at: ${mainAddress}`);
    saveState({ mainAddress, mainDeployTx });
  } else {
    console.log(`[SKIP] Main contract already deployed at: ${mainAddress}`);
  }

  // Fetch deployed on-chain code and verify byte-for-byte equality
  console.log('Fetching deployed code from StudioNet RPC...');
  const onChainCode = await clientBuyer.getContractCode(mainAddress);
  onChainSha256 = sha256(onChainCode);
  console.log(`On-chain code sha256   : ${onChainSha256}`);

  blobEquality = (mainCode === onChainCode) && (localSha256 === onChainSha256);
  console.log(`Byte-for-byte equality : ${blobEquality ? 'MATCH (100% byte-for-byte)' : 'MISMATCH'}`);
  saveState({ onChainSha256, blobEquality });
  updateManifest();
  if (!blobEquality) {
    throw new Error('CRITICAL: Bytecode mismatch against deployed contract!');
  }

  // ---------------------------------------------------------------------------
  // STEP D: LIVE DEMO: 14 STEPS (S1-S8, X1-X6) FOR TENDER 2
  // ---------------------------------------------------------------------------
  console.log(`\n--- STEP D: LIVE DEMO (S1-S8, X1-X6) FOR TENDER ${tenderId} ---`);

  const tenderSpec = 'Mandatory technical requirements: (1) FIPS 140-3 Level 3 certification, (2) at least 10,000 ECDSA-P256 signing operations per second, and (3) dual redundant hot-swappable power supplies.';
  const tenderTitle = 'Production HSM Cluster Procurement';
  const reservePrice = 500;
  const commitDuration = 240;
  const revealDuration = 480;

  const vendorBSummary = 'BudgetBox Mini-HSM: FIPS 140-2 Level 2 only, 3,200 ECDSA-P256 ops/sec, single non-redundant power supply.';
  const vendorBSalt = 'salt_vendor_b_120';
  const vendorBPrice = 120;

  const vendorASummary = 'NitroVault HSM-3000: FIPS 140-3 Level 3 certified, 14,500 ECDSA-P256 ops/sec, dual redundant hot-swappable power supplies.';
  const vendorASalt = 'salt_vendor_a_210';
  const vendorAPrice = 210;

  const vendorCSummary = 'AegisCore HSM-9000: FIPS 140-3 Level 3 certified, 22,000 ECDSA-P256 ops/sec, dual redundant hot-swappable power supplies.';
  const vendorCSalt = 'salt_vendor_c_340';
  const vendorCPrice = 340;

  // Helper for LLM steps with STOP RULE: allow at most ONE resubmission if MAJORITY_DISAGREE / UNDETERMINED
  async function callLLMStepWithRetry(client, { functionName, args, expectedReturn, stepName, accountLetter, scenario }) {
    console.log(`\n[${stepName}] Calling ${functionName}(${args.map(a => JSON.stringify(a)).join(', ')})...`);
    let res = await safeWrite(client, {
      address: mainAddress,
      functionName,
      args,
      expectSuccess: false
    });

    let returnStr = String(res.receipt?.returnReadable || '');
    let consensusResult = res.receipt?.result || 'UNKNOWN';

    if (consensusResult === 'MAJORITY_DISAGREE' || consensusResult === 'UNDETERMINED') {
      console.warn(`  [Consensus non-agreement in ${stepName}]: ${consensusResult}. Making ONE identical resubmission per STOP RULE...`);
      res = await safeWrite(client, {
        address: mainAddress,
        functionName,
        args,
        expectSuccess: false
      });
      returnStr = String(res.receipt?.returnReadable || '');
      consensusResult = res.receipt?.result || 'UNKNOWN';
    }

    if (res.receipt?.executionResult !== 'SUCCESS') {
      console.error(`STOP RULE: ${stepName} GenVM execution failed with ${res.receipt?.executionResult}: ${res.receipt?.stderr}`);
      process.exit(1);
    }

    if (expectedReturn && returnStr !== expectedReturn) {
      console.error(`STOP RULE: ${stepName} expected "${expectedReturn}", got "${returnStr}"`);
      process.exit(1);
    }

    return { res, returnStr, consensusResult };
  }

  // ===========================================================================
  // S1 (Buyer): open_tender
  // ===========================================================================
  let stepS1 = getStep('S1');
  if (!stepS1) {
    console.log(`\n[S1] Buyer: open_tender("${tenderTitle}", ..., ${reservePrice}, ${commitDuration}, ${revealDuration})...`);
    const res = await safeWrite(clientBuyer, {
      address: mainAddress,
      functionName: 'open_tender',
      args: [tenderTitle, tenderSpec, reservePrice, commitDuration, revealDuration],
      expectSuccess: true
    });

    tenderId = Number(res.receipt.returnReadable) || 3;
    saveState({ tenderId });
    console.log(`  Tender opened with ID: ${tenderId}`);

    const tenderRaw = await readContractWithRetry(clientBuyer, {
      address: mainAddress,
      functionName: 'get_tender',
      args: [tenderId]
    });
    const tenderObj = JSON.parse(tenderRaw);

    stepS1 = {
      step: 'S1',
      scenario: 'Open Procurement Tender with Technical Specification',
      method: 'open_tender',
      account: 'Buyer',
      args: [tenderTitle, tenderSpec, reservePrice, commitDuration, revealDuration],
      hash: res.txHash,
      status: res.receipt.status,
      executionResult: res.receipt.executionResult,
      consensusResult: res.receipt.result,
      returnOrError: String(res.receipt.returnReadable),
      votes: res.receipt.votes || {},
      expected: String(tenderId),
      actual: String(res.receipt.returnReadable),
      expectedFailure: false,
      readBack: tenderObj
    };
    recordStep(stepS1);
  } else {
    tenderId = Number(stepS1.returnOrError) || state.tenderId || 3;
    console.log(`[SKIP] S1 already executed: ${stepS1.hash} (Tender ID: ${tenderId})`);
  }

  // Fetch current tender state for deadlines
  let currentTender = JSON.parse(await readContractWithRetry(clientBuyer, {
    address: mainAddress,
    functionName: 'get_tender',
    args: [tenderId]
  }));

  // Calculate commitment hashes for tenderId
  const hashB = computeCommitmentHash(tenderId, vendorBAccount.address, vendorBPrice, e2_url, vendorBSummary, vendorBSalt);
  const hashA = computeCommitmentHash(tenderId, vendorAAccount.address, vendorAPrice, e1_url, vendorASummary, vendorASalt);
  const hashC = computeCommitmentHash(tenderId, vendorCAccount.address, vendorCPrice, e3_url, vendorCSummary, vendorCSalt);

  console.log(`Commitment Hash B (Lowball): ${hashB}`);
  console.log(`Commitment Hash A (Compliant): ${hashA}`);
  console.log(`Commitment Hash C (Compliant): ${hashC}`);

  // ===========================================================================
  // S2 (Vendor B): commit_bid
  // ===========================================================================
  let stepS2 = getStep('S2');
  if (!stepS2) {
    console.log(`\n[S2] Vendor B: commit_bid(${tenderId}, ${hashB})...`);
    const expected = `COMMITTED:TENDER_${tenderId}:VENDOR_${vendorBAccount.address.toLowerCase()}`;
    const res = await safeWrite(clientVendorB, {
      address: mainAddress,
      functionName: 'commit_bid',
      args: [tenderId, hashB],
      expectSuccess: true
    });
    const returnStr = String(res.receipt.returnReadable);
    console.log(`  Vendor B committed, return: ${returnStr}`);
    if (returnStr.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`S2 return mismatch: expected ${expected}, got ${returnStr}`);
    }

    const tRaw = JSON.parse(await readContractWithRetry(clientVendorB, {
      address: mainAddress,
      functionName: 'get_tender',
      args: [tenderId]
    }));

    stepS2 = {
      step: 'S2',
      scenario: 'Vendor B Submits Cryptographic Bid Commitment',
      method: 'commit_bid',
      account: 'Vendor B',
      args: [tenderId, hashB],
      hash: res.txHash,
      status: res.receipt.status,
      executionResult: res.receipt.executionResult,
      consensusResult: res.receipt.result,
      returnOrError: returnStr,
      votes: res.receipt.votes || {},
      expected,
      actual: returnStr,
      expectedFailure: false,
      readBack: { commitsCount: Object.keys(tRaw.commits || {}).length, commits: tRaw.commits }
    };
    recordStep(stepS2);
  } else {
    console.log(`[SKIP] S2 already executed: ${stepS2.hash}`);
  }

  // ===========================================================================
  // S3 (Vendor A): commit_bid
  // ===========================================================================
  let stepS3 = getStep('S3');
  if (!stepS3) {
    console.log(`\n[S3] Vendor A: commit_bid(${tenderId}, ${hashA})...`);
    const expected = `COMMITTED:TENDER_${tenderId}:VENDOR_${vendorAAccount.address.toLowerCase()}`;
    const res = await safeWrite(clientVendorA, {
      address: mainAddress,
      functionName: 'commit_bid',
      args: [tenderId, hashA],
      expectSuccess: true
    });
    const returnStr = String(res.receipt.returnReadable);
    console.log(`  Vendor A committed, return: ${returnStr}`);
    if (returnStr.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`S3 return mismatch: expected ${expected}, got ${returnStr}`);
    }

    const tRaw = JSON.parse(await readContractWithRetry(clientVendorA, {
      address: mainAddress,
      functionName: 'get_tender',
      args: [tenderId]
    }));

    stepS3 = {
      step: 'S3',
      scenario: 'Vendor A Submits Cryptographic Bid Commitment',
      method: 'commit_bid',
      account: 'Vendor A',
      args: [tenderId, hashA],
      hash: res.txHash,
      status: res.receipt.status,
      executionResult: res.receipt.executionResult,
      consensusResult: res.receipt.result,
      returnOrError: returnStr,
      votes: res.receipt.votes || {},
      expected,
      actual: returnStr,
      expectedFailure: false,
      readBack: { commitsCount: Object.keys(tRaw.commits || {}).length, commits: tRaw.commits }
    };
    recordStep(stepS3);
  } else {
    console.log(`[SKIP] S3 already executed: ${stepS3.hash}`);
  }

  // ===========================================================================
  // S4 (Vendor C): commit_bid
  // ===========================================================================
  let stepS4 = getStep('S4');
  if (!stepS4) {
    console.log(`\n[S4] Vendor C: commit_bid(${tenderId}, ${hashC})...`);
    const expected = `COMMITTED:TENDER_${tenderId}:VENDOR_${vendorCAccount.address.toLowerCase()}`;
    const res = await safeWrite(clientVendorC, {
      address: mainAddress,
      functionName: 'commit_bid',
      args: [tenderId, hashC],
      expectSuccess: true
    });
    const returnStr = String(res.receipt.returnReadable);
    console.log(`  Vendor C committed, return: ${returnStr}`);
    if (returnStr.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`S4 return mismatch: expected ${expected}, got ${returnStr}`);
    }

    const tRaw = JSON.parse(await readContractWithRetry(clientVendorC, {
      address: mainAddress,
      functionName: 'get_tender',
      args: [tenderId]
    }));

    stepS4 = {
      step: 'S4',
      scenario: 'Vendor C Submits Cryptographic Bid Commitment',
      method: 'commit_bid',
      account: 'Vendor C',
      args: [tenderId, hashC],
      hash: res.txHash,
      status: res.receipt.status,
      executionResult: res.receipt.executionResult,
      consensusResult: res.receipt.result,
      returnOrError: returnStr,
      votes: res.receipt.votes || {},
      expected,
      actual: returnStr,
      expectedFailure: false,
      readBack: { commitsCount: Object.keys(tRaw.commits || {}).length, commits: tRaw.commits }
    };
    recordStep(stepS4);
  } else {
    console.log(`[SKIP] S4 already executed: ${stepS4.hash}`);
  }

  // ===========================================================================
  // X1 (Vendor A): Duplicate Commit Blocked
  // ===========================================================================
  let stepX1 = getStep('X1');
  if (!stepX1) {
    console.log('\n[X1] Vendor A: Duplicate commit_bid (expect ALREADY_COMMITTED)...');
    const res = await safeWrite(clientVendorA, {
      address: mainAddress,
      functionName: 'commit_bid',
      args: [tenderId, hashA],
      expectSuccess: false
    });

    const errStr = res.clientError?.message || res.receipt?.stderr || JSON.stringify(res.receipt?.returnReadable);
    console.log('  Duplicate commit error received:', errStr);
    if (!errStr.includes('ALREADY_COMMITTED')) {
      console.error('STOP RULE: X1 did not fail with ALREADY_COMMITTED!');
      process.exit(1);
    }

    stepX1 = {
      step: 'X1',
      scenario: 'Expected Failure: Duplicate Bid Commitment Blocked',
      method: 'commit_bid',
      account: 'Vendor A',
      args: [tenderId, hashA],
      hash: res.txHash,
      status: res.receipt?.status || 'LOCAL_CLIENT_REJECTED',
      executionResult: res.receipt?.executionResult || 'ERROR',
      consensusResult: res.receipt?.result || 'N/A',
      returnOrError: errStr,
      votes: res.receipt?.votes || {},
      expected: 'UserError: ALREADY_COMMITTED',
      actual: errStr,
      expectedFailure: true,
      readBack: 'Duplicate commit blocked by vendor address uniqueness'
    };
    recordStep(stepX1);
  } else {
    console.log(`[SKIP] X1 already executed: ${stepX1.hash}`);
  }

  // ===========================================================================
  // X2 (Vendor A): Premature Reveal before commit_deadline Blocked
  // ===========================================================================
  let stepX2 = getStep('X2');
  if (!stepX2) {
    console.log('\n[X2] Vendor A: Premature reveal before commit_deadline (expect COMMIT_PHASE_NOT_ENDED)...');
    const res = await safeWrite(clientVendorA, {
      address: mainAddress,
      functionName: 'reveal_and_evaluate',
      args: [tenderId, vendorAPrice, e1_url, vendorASummary, vendorASalt],
      expectSuccess: false
    });

    const errStr = res.clientError?.message || res.receipt?.stderr || JSON.stringify(res.receipt?.returnReadable);
    console.log('  Premature reveal error received:', errStr);
    if (!errStr.includes('COMMIT_PHASE_NOT_ENDED')) {
      console.error('STOP RULE: X2 did not fail with COMMIT_PHASE_NOT_ENDED!');
      process.exit(1);
    }

    stepX2 = {
      step: 'X2',
      scenario: 'Expected Failure: Premature Bid Reveal Blocked Before Commit Deadline',
      method: 'reveal_and_evaluate',
      account: 'Vendor A',
      args: [tenderId, vendorAPrice, e1_url, vendorASummary, vendorASalt],
      hash: res.txHash,
      status: res.receipt?.status || 'LOCAL_CLIENT_REJECTED',
      executionResult: res.receipt?.executionResult || 'ERROR',
      consensusResult: res.receipt?.result || 'N/A',
      returnOrError: errStr,
      votes: res.receipt?.votes || {},
      expected: 'UserError: COMMIT_PHASE_NOT_ENDED',
      actual: errStr,
      expectedFailure: true,
      readBack: 'Premature reveal strictly rejected by timestamp check'
    };
    recordStep(stepX2);
  } else {
    console.log(`[SKIP] X2 already executed: ${stepX2.hash}`);
  }

  // ===========================================================================
  // WAIT FOR COMMIT DEADLINE
  // ===========================================================================
  currentTender = JSON.parse(await readContractWithRetry(clientBuyer, {
    address: mainAddress,
    functionName: 'get_tender',
    args: [tenderId]
  }));
  const commitDeadline = Number(currentTender.commit_deadline);
  console.log(`\nTender Commit Deadline: ${commitDeadline} (ISO: ${new Date(commitDeadline * 1000).toISOString()})`);

  while (true) {
    const nowSec = Math.floor(Date.now() / 1000);
    const remaining = (commitDeadline + 10) - nowSec;
    if (remaining <= 0) {
      console.log('Commit deadline passed with buffer. Proceeding to Reveal phase!');
      break;
    }
    console.log(`[WAIT] ${remaining}s remaining until commit deadline...`);
    await new Promise(r => setTimeout(r, Math.min(remaining * 1000, 20000)));
  }

  // ===========================================================================
  // X3 (Vendor A): Reveal with Tampered Price Blocked
  // ===========================================================================
  let stepX3 = getStep('X3');
  if (!stepX3) {
    console.log('\n[X3] Vendor A: Reveal with tampered price 190 (expect COMMITMENT_MISMATCH)...');
    const tamperedPrice = 190;
    const res = await safeWrite(clientVendorA, {
      address: mainAddress,
      functionName: 'reveal_and_evaluate',
      args: [tenderId, tamperedPrice, e1_url, vendorASummary, vendorASalt],
      expectSuccess: false
    });

    const errStr = res.clientError?.message || res.receipt?.stderr || JSON.stringify(res.receipt?.returnReadable);
    console.log('  Commitment mismatch error received:', errStr);
    if (!errStr.includes('COMMITMENT_MISMATCH')) {
      console.error('STOP RULE: X3 did not fail with COMMITMENT_MISMATCH!');
      process.exit(1);
    }

    stepX3 = {
      step: 'X3',
      scenario: 'Expected Failure: Tampered Bid Parameters Blocked by Cryptographic Mismatch',
      method: 'reveal_and_evaluate',
      account: 'Vendor A',
      args: [tenderId, tamperedPrice, e1_url, vendorASummary, vendorASalt],
      hash: res.txHash,
      status: res.receipt?.status || 'LOCAL_CLIENT_REJECTED',
      executionResult: res.receipt?.executionResult || 'ERROR',
      consensusResult: res.receipt?.result || 'N/A',
      returnOrError: errStr,
      votes: res.receipt?.votes || {},
      expected: 'UserError: COMMITMENT_MISMATCH',
      actual: errStr,
      expectedFailure: true,
      readBack: 'Tampered bid hash rejected against committed sha256'
    };
    recordStep(stepX3);
  } else {
    console.log(`[SKIP] X3 already executed: ${stepX3.hash}`);
  }

  // ===========================================================================
  // S5 (Vendor B): reveal_and_evaluate (lowball non-compliant -> INELIGIBLE)
  // ===========================================================================
  let stepS5 = getStep('S5');
  if (!stepS5) {
    const expected = `REVEALED:ELIGIBILITY_INELIGIBLE:PRICE_${vendorBPrice}`;
    const { res, returnStr, consensusResult } = await callLLMStepWithRetry(clientVendorB, {
      functionName: 'reveal_and_evaluate',
      args: [tenderId, vendorBPrice, e2_url, vendorBSummary, vendorBSalt],
      expectedReturn: expected,
      stepName: 'S5',
      accountLetter: 'Vendor B',
      scenario: 'Vendor B Reveals Lowball Non-Compliant Bid (LLM Disqualifies as INELIGIBLE)'
    });

    const tRaw = JSON.parse(await readContractWithRetry(clientVendorB, {
      address: mainAddress,
      functionName: 'get_tender',
      args: [tenderId]
    }));

    stepS5 = {
      step: 'S5',
      scenario: 'Vendor B Reveals Lowball Non-Compliant Bid (LLM Disqualifies as INELIGIBLE)',
      method: 'reveal_and_evaluate',
      account: 'Vendor B',
      args: [tenderId, vendorBPrice, e2_url, vendorBSummary, vendorBSalt],
      hash: res.txHash,
      status: res.receipt.status,
      executionResult: res.receipt.executionResult,
      consensusResult,
      returnOrError: returnStr,
      votes: res.receipt.votes || {},
      expected,
      actual: returnStr,
      expectedFailure: false,
      readBack: { revealedBidsCount: tRaw.revealed_bids?.length, lastRevealed: tRaw.revealed_bids?.slice(-1)[0] }
    };
    recordStep(stepS5);
  } else {
    console.log(`[SKIP] S5 already executed: ${stepS5.hash}`);
  }

  // ===========================================================================
  // S6 (Vendor A): reveal_and_evaluate (compliant -> ELIGIBLE)
  // ===========================================================================
  let stepS6 = getStep('S6');
  if (!stepS6) {
    const expected = `REVEALED:ELIGIBILITY_ELIGIBLE:PRICE_${vendorAPrice}`;
    const { res, returnStr, consensusResult } = await callLLMStepWithRetry(clientVendorA, {
      functionName: 'reveal_and_evaluate',
      args: [tenderId, vendorAPrice, e1_url, vendorASummary, vendorASalt],
      expectedReturn: expected,
      stepName: 'S6',
      accountLetter: 'Vendor A',
      scenario: 'Vendor A Reveals Compliant Bid (LLM Verifies and Evaluates as ELIGIBLE)'
    });

    const tRaw = JSON.parse(await readContractWithRetry(clientVendorA, {
      address: mainAddress,
      functionName: 'get_tender',
      args: [tenderId]
    }));

    stepS6 = {
      step: 'S6',
      scenario: 'Vendor A Reveals Compliant Bid (LLM Verifies and Evaluates as ELIGIBLE)',
      method: 'reveal_and_evaluate',
      account: 'Vendor A',
      args: [tenderId, vendorAPrice, e1_url, vendorASummary, vendorASalt],
      hash: res.txHash,
      status: res.receipt.status,
      executionResult: res.receipt.executionResult,
      consensusResult,
      returnOrError: returnStr,
      votes: res.receipt.votes || {},
      expected,
      actual: returnStr,
      expectedFailure: false,
      readBack: { revealedBidsCount: tRaw.revealed_bids?.length, lastRevealed: tRaw.revealed_bids?.slice(-1)[0] }
    };
    recordStep(stepS6);
  } else {
    console.log(`[SKIP] S6 already executed: ${stepS6.hash}`);
  }

  // ===========================================================================
  // S7 (Vendor C): reveal_and_evaluate (compliant -> ELIGIBLE)
  // ===========================================================================
  let stepS7 = getStep('S7');
  if (!stepS7) {
    const expected = `REVEALED:ELIGIBILITY_ELIGIBLE:PRICE_${vendorCPrice}`;
    const { res, returnStr, consensusResult } = await callLLMStepWithRetry(clientVendorC, {
      functionName: 'reveal_and_evaluate',
      args: [tenderId, vendorCPrice, e3_url, vendorCSummary, vendorCSalt],
      expectedReturn: expected,
      stepName: 'S7',
      accountLetter: 'Vendor C',
      scenario: 'Vendor C Reveals Compliant Higher Bid (LLM Verifies and Evaluates as ELIGIBLE)'
    });

    const tRaw = JSON.parse(await readContractWithRetry(clientVendorC, {
      address: mainAddress,
      functionName: 'get_tender',
      args: [tenderId]
    }));

    stepS7 = {
      step: 'S7',
      scenario: 'Vendor C Reveals Compliant Higher Bid (LLM Verifies and Evaluates as ELIGIBLE)',
      method: 'reveal_and_evaluate',
      account: 'Vendor C',
      args: [tenderId, vendorCPrice, e3_url, vendorCSummary, vendorCSalt],
      hash: res.txHash,
      status: res.receipt.status,
      executionResult: res.receipt.executionResult,
      consensusResult,
      returnOrError: returnStr,
      votes: res.receipt.votes || {},
      expected,
      actual: returnStr,
      expectedFailure: false,
      readBack: { revealedBidsCount: tRaw.revealed_bids?.length, lastRevealed: tRaw.revealed_bids?.slice(-1)[0] }
    };
    recordStep(stepS7);
  } else {
    console.log(`[SKIP] S7 already executed: ${stepS7.hash}`);
  }

  // ===========================================================================
  // X4 (Vendor A): Duplicate Reveal Blocked
  // ===========================================================================
  let stepX4 = getStep('X4');
  if (!stepX4) {
    console.log('\n[X4] Vendor A: Duplicate reveal_and_evaluate (expect ALREADY_REVEALED)...');
    const res = await safeWrite(clientVendorA, {
      address: mainAddress,
      functionName: 'reveal_and_evaluate',
      args: [tenderId, vendorAPrice, e1_url, vendorASummary, vendorASalt],
      expectSuccess: false
    });

    const errStr = res.clientError?.message || res.receipt?.stderr || JSON.stringify(res.receipt?.returnReadable);
    console.log('  Duplicate reveal error received:', errStr);
    if (!errStr.includes('ALREADY_REVEALED')) {
      console.error('STOP RULE: X4 did not fail with ALREADY_REVEALED!');
      process.exit(1);
    }

    stepX4 = {
      step: 'X4',
      scenario: 'Expected Failure: Duplicate Bid Reveal Blocked',
      method: 'reveal_and_evaluate',
      account: 'Vendor A',
      args: [tenderId, vendorAPrice, e1_url, vendorASummary, vendorASalt],
      hash: res.txHash,
      status: res.receipt?.status || 'LOCAL_CLIENT_REJECTED',
      executionResult: res.receipt?.executionResult || 'ERROR',
      consensusResult: res.receipt?.result || 'N/A',
      returnOrError: errStr,
      votes: res.receipt?.votes || {},
      expected: 'UserError: ALREADY_REVEALED',
      actual: errStr,
      expectedFailure: true,
      readBack: 'Duplicate reveal blocked by revealed flag'
    };
    recordStep(stepX4);
  } else {
    console.log(`[SKIP] X4 already executed: ${stepX4.hash}`);
  }

  // ===========================================================================
  // X5 (Buyer): Premature settle_tender before reveal_deadline Blocked
  // ===========================================================================
  let stepX5 = getStep('X5');
  if (!stepX5) {
    console.log('\n[X5] Buyer: Premature settle_tender before reveal_deadline (expect REVEAL_PHASE_NOT_ENDED)...');
    const res = await safeWrite(clientBuyer, {
      address: mainAddress,
      functionName: 'settle_tender',
      args: [tenderId],
      expectSuccess: false
    });

    const errStr = res.clientError?.message || res.receipt?.stderr || JSON.stringify(res.receipt?.returnReadable);
    console.log('  Premature settlement error received:', errStr);
    if (!errStr.includes('REVEAL_PHASE_NOT_ENDED')) {
      console.error('STOP RULE: X5 did not fail with REVEAL_PHASE_NOT_ENDED!');
      process.exit(1);
    }

    stepX5 = {
      step: 'X5',
      scenario: 'Expected Failure: Premature Tender Settlement Blocked Before Reveal Deadline',
      method: 'settle_tender',
      account: 'Buyer',
      args: [tenderId],
      hash: res.txHash,
      status: res.receipt?.status || 'LOCAL_CLIENT_REJECTED',
      executionResult: res.receipt?.executionResult || 'ERROR',
      consensusResult: res.receipt?.result || 'N/A',
      returnOrError: errStr,
      votes: res.receipt?.votes || {},
      expected: 'UserError: REVEAL_PHASE_NOT_ENDED',
      actual: errStr,
      expectedFailure: true,
      readBack: 'Premature settlement strictly rejected by reveal timestamp check'
    };
    recordStep(stepX5);
  } else {
    console.log(`[SKIP] X5 already executed: ${stepX5.hash}`);
  }

  // ===========================================================================
  // WAIT FOR REVEAL DEADLINE
  // ===========================================================================
  currentTender = JSON.parse(await readContractWithRetry(clientBuyer, {
    address: mainAddress,
    functionName: 'get_tender',
    args: [tenderId]
  }));
  const revealDeadline = Number(currentTender.reveal_deadline);
  console.log(`\nTender Reveal Deadline: ${revealDeadline} (ISO: ${new Date(revealDeadline * 1000).toISOString()})`);

  while (true) {
    const nowSec = Math.floor(Date.now() / 1000);
    const remaining = (revealDeadline + 10) - nowSec;
    if (remaining <= 0) {
      console.log('Reveal deadline passed with buffer. Proceeding to Settlement!');
      break;
    }
    console.log(`[WAIT] ${remaining}s remaining until reveal deadline...`);
    await new Promise(r => setTimeout(r, Math.min(remaining * 1000, 20000)));
  }

  // ===========================================================================
  // S8 (Vendor C): Permissionless settle_tender
  // ===========================================================================
  let stepS8 = getStep('S8');
  if (!stepS8) {
    console.log('\n[S8] Vendor C: Permissionless settle_tender...');
    const res = await safeWrite(clientVendorC, {
      address: mainAddress,
      functionName: 'settle_tender',
      args: [tenderId],
      expectSuccess: true
    });

    const returnStr = String(res.receipt.returnReadable);
    console.log(`  Settle result: ${returnStr}`);

    // Expected: SETTLED:AWARDED:WINNER_<Vendor_A>:CLEARING_340
    if (!returnStr.startsWith('SETTLED:AWARDED:') || !returnStr.includes('CLEARING_340')) {
      throw new Error(`S8 return mismatch: unexpected settlement output: ${returnStr}`);
    }

    const tRaw = JSON.parse(await readContractWithRetry(clientVendorC, {
      address: mainAddress,
      functionName: 'get_tender',
      args: [tenderId]
    }));

    stepS8 = {
      step: 'S8',
      scenario: 'Permissionless Vickrey Second-Price Settlement (Awards Vendor A at Clearing Price 340)',
      method: 'settle_tender',
      account: 'Vendor C',
      args: [tenderId],
      hash: res.txHash,
      status: res.receipt.status,
      executionResult: res.receipt.executionResult,
      consensusResult: res.receipt.result,
      returnOrError: returnStr,
      votes: res.receipt.votes || {},
      expected: `SETTLED:AWARDED:WINNER_${vendorAAccount.address}:CLEARING_340`,
      actual: returnStr,
      expectedFailure: false,
      readBack: { status: tRaw.status, settlement: tRaw.settlement }
    };
    recordStep(stepS8);
  } else {
    console.log(`[SKIP] S8 already executed: ${stepS8.hash}`);
  }

  // ===========================================================================
  // X6 (Buyer): Double Settlement Blocked
  // ===========================================================================
  let stepX6 = getStep('X6');
  if (!stepX6) {
    console.log('\n[X6] Buyer: Double settle_tender (expect TENDER_ALREADY_SETTLED)...');
    const res = await safeWrite(clientBuyer, {
      address: mainAddress,
      functionName: 'settle_tender',
      args: [tenderId],
      expectSuccess: false
    });

    const errStr = res.clientError?.message || res.receipt?.stderr || JSON.stringify(res.receipt?.returnReadable);
    console.log('  Double settlement error received:', errStr);
    if (!errStr.includes('TENDER_ALREADY_SETTLED')) {
      console.error('STOP RULE: X6 did not fail with TENDER_ALREADY_SETTLED!');
      process.exit(1);
    }

    stepX6 = {
      step: 'X6',
      scenario: 'Expected Failure: Double Settlement Blocked',
      method: 'settle_tender',
      account: 'Buyer',
      args: [tenderId],
      hash: res.txHash,
      status: res.receipt?.status || 'LOCAL_CLIENT_REJECTED',
      executionResult: res.receipt?.executionResult || 'ERROR',
      consensusResult: res.receipt?.result || 'N/A',
      returnOrError: errStr,
      votes: res.receipt?.votes || {},
      expected: 'UserError: TENDER_ALREADY_SETTLED',
      actual: errStr,
      expectedFailure: true,
      readBack: 'Double settlement prevented by status check'
    };
    recordStep(stepX6);
  } else {
    console.log(`[SKIP] X6 already executed: ${stepX6.hash}`);
  }

  // Final update of manifest
  updateManifest();

  console.log('\n===============================================================');
  console.log('  All 14 steps (S1-S8, X1-X6) completed and recorded!          ');
  console.log('===============================================================');
}

main().catch(err => {
  console.error('\nFATAL ERROR in deploy_and_demo:', err);
  process.exit(1);
});
