import type { Metadata } from 'next';

import { DocPage } from '@/components/docs/DocPage';
import { B, C, Callout, CodeBlock, H2, LI, OL, P, Step, Table, UL } from '@/components/docs/prose';
import { readDeployment } from '@/lib/live/deployment';
import { USDG } from '@/lib/site';
import { formatAmount } from '@/lib/units';

export const metadata: Metadata = {
  title: 'Gasless betting',
  description:
    'A Hunch bet is one signature: a USDG transfer authorization bound to one market, side and amount. What you sign, and what the relayer can and cannot do.',
  alternates: { canonical: '/docs/gasless' },
};

const TOC = [
  { id: 'one-signature', label: 'One signature' },
  { id: 'what-you-sign', label: 'What you sign' },
  { id: 'binding', label: 'How the bet is bound' },
  { id: 'relayer', label: 'What the relayer can and cannot do' },
  { id: 'checks', label: 'Checks before sending' },
  { id: 'wallets', label: 'Wallets' },
  { id: 'pay-gas', label: 'Paying the gas yourself' },
] as const;

export default function GaslessDoc() {
  const deployment = readDeployment();
  const settler = deployment.contracts.HunchVPM.address;
  const { params } = deployment;
  const min = formatAmount(BigInt(params.minEntry), { fractionDigits: 0 });
  const max = formatAmount(BigInt(params.maxEntry), { fractionDigits: 0 });

  return (
    <DocPage slug="gasless" toc={TOC}>
      <H2 id="one-signature">One signature</H2>
      <P>
        USDG supports signed transfers (EIP-3009): instead of sending a transaction, you sign a message that authorises
        one specific transfer, and someone else submits it. Hunch uses that so a bet needs <B>no ETH and no approval</B>:
      </P>
      <OL>
        <Step n={1} title="You sign">
          Your wallet signs a USDG &ldquo;receive with authorization&rdquo; for exactly your stake, payable only to the betting
          contract, with a one-time code that names the market, the side and the amount.
        </Step>
        <Step n={2} title="Hunch relays it">
          The site posts the signature to Hunch&rsquo;s relayer, which checks it, simulates it and sends{' '}
          <C>enterWithAuthorization</C>, paying the gas (well under a cent).
        </Step>
        <Step n={3} title="The contract books your bet">
          The betting contract runs every normal check, books the position <B>for you</B> (the signer, never the sender),
          then pulls the USDG with your authorization. Your position appears when the transaction confirms.
        </Step>
      </OL>

      <H2 id="what-you-sign">What you sign</H2>
      <P>
        EIP-712 typed data in USDG&rsquo;s own signing domain. USDG does not publish its domain on-chain, so it is fixed in
        the app exactly as the token computes it (the resulting separator was recomputed and matched on-chain).
      </P>
      <CodeBlock label="The typed data your wallet shows (example: 25 USDG)">{`{
  "domain": {
    "name": "Global Dollar",
    "version": "1",
    "chainId": 4663,
    "verifyingContract": "${USDG.address}"
  },
  "primaryType": "ReceiveWithAuthorization",
  "types": {
    "ReceiveWithAuthorization": [
      { "name": "from",        "type": "address" },
      { "name": "to",          "type": "address" },
      { "name": "value",       "type": "uint256" },
      { "name": "validAfter",  "type": "uint256" },
      { "name": "validBefore", "type": "uint256" },
      { "name": "nonce",       "type": "bytes32" }
    ]
  },
  "message": {
    "from":        "<your address>",
    "to":          "${settler ?? '<the HunchVPM contract>'}",
    "value":       "25000000",
    "validAfter":  "0",
    "validBefore": "<a few minutes from now>",
    "nonce":       "<enterNonce(marketId, outcome, amount, salt)>"
  }
}`}</CodeBlock>
      <P>
        <C>value</C> is in USDG&rsquo;s 6 decimals (25000000 is 25.00 USDG). <C>to</C> is always the betting contract.
      </P>

      <H2 id="binding">How the bet is bound</H2>
      <P>
        The one-time code (the EIP-3009 <C>nonce</C>) is not random. It is computed from the bet itself, so the signature is
        only valid for that bet:
      </P>
      <CodeBlock label="HunchVPM">{`bytes32 public constant ENTER_TYPEHASH =
    keccak256("HunchEnter(uint256 marketId,uint8 outcome,uint256 amount,bytes32 salt)");

function enterNonce(uint256 marketId, uint8 outcome, uint256 amount, bytes32 salt)
    public view returns (bytes32)
{
    return keccak256(abi.encode(ENTER_TYPEHASH, block.chainid, address(this),
                                marketId, outcome, amount, salt));
}`}</CodeBlock>
      <P>
        When the relayer calls <C>enterWithAuthorization(from, marketId, outcome, amount, validAfter, validBefore, salt,
        signature)</C>, the contract recomputes the code from the market, side and amount it was given and hands it to USDG.
        If any of them differ from what you signed, the code differs, your signature does not match, and USDG rejects the
        transfer. Outcome <C>0</C> is UP and <C>1</C> is DOWN. The <C>salt</C> is a random value so two identical bets have
        different codes.
      </P>

      <H2 id="relayer">What the relayer can and cannot do</H2>
      <Table
        caption="The relayer's powers"
        head={['The relayer can', 'The relayer cannot']}
        minWidth={520}
        rows={[
          [
            'Submit your signed bet, and pay its gas.',
            'Change the market, the side or the amount: the code would no longer match your signature.',
          ],
          [
            'Choose when to send it, inside the validity window you signed.',
            'Send your USDG anywhere else: USDG only lets the named receiver (the betting contract) pull it.',
          ],
          [
            'Refuse to send it (for example if it fails a check).',
            'Take the position: it is booked for the signer, never the sender.',
          ],
          ['', 'Use the signature twice: USDG marks the code used.'],
        ]}
      />
      <Callout title="If the relayer is down or refuses">
        <p>
          Anyone may call <C>enterWithAuthorization</C>, including you: the same signed bet can be sent from any wallet with
          a little ETH. Or skip the signature and pay the gas yourself (below). The validity window is kept short so a
          signature cannot sit unused for long.
        </p>
      </Callout>

      <H2 id="checks">Checks before sending</H2>
      <P>Before it spends gas on your bet, the relayer checks off-chain, then simulates:</P>
      <UL>
        <LI>the signature is over USDG&rsquo;s domain on chain 4663 and is valid for <C>from</C>;</LI>
        <LI>the code equals <C>enterNonce(marketId, outcome, amount, salt)</C>;</LI>
        <LI>the validity window is open;</LI>
        <LI>
          the amount is between {min} and {max} USDG, the market is taking bets, and new bets are not paused;
        </LI>
        <LI>the request does not come from a blocked country;</LI>
        <LI>no more than 10 requests a minute from one IP address or one signer.</LI>
      </UL>
      <P>
        The contract then runs the same rules again on-chain: open, not past the bell, a valid side, inside the limits, not
        paused. The relayer&rsquo;s checks save gas; the contract&rsquo;s checks are the ones that matter.
      </P>

      <H2 id="wallets">Wallets</H2>
      <UL>
        <LI>
          <B>Your wallet must be on Robinhood Chain to sign.</B> Wallets such as MetaMask refuse typed data whose domain chain
          id differs from the active network, so the bet button walks you through connect, switch (free) and sign.
        </LI>
        <LI>
          <B>Smart-contract wallets</B> can sign too: USDG accepts the byte-string signature form that checks a contract
          wallet&rsquo;s own signature rule (ERC-1271).
        </LI>
      </UL>

      <H2 id="pay-gas">Paying the gas yourself</H2>
      <P>
        The fallback path is two ordinary transactions from your wallet on Robinhood Chain: <C>approve</C> USDG to the betting
        contract, then <C>enter(marketId, outcome, amount)</C>. It needs a little ETH (a bet costs well under a cent) and
        does not involve the relayer at all.
      </P>
    </DocPage>
  );
}
