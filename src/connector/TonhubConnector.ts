import axios from "axios";
import { getSecureRandomBytes, keyPairFromSeed } from "ton-crypto";
import { backoff } from "../utils/backoff";
import { toUrlSafe } from "../utils/toURLsafe";
import * as t from 'io-ts';
import { delay } from "teslabot-fix";
import { Cell, Address, beginCell, CommentMessage, safeSign, contractAddress, safeSignVerify } from 'ton';
import BN from 'bn.js';
import { WalletV4Source } from 'ton-contracts';

const sessionStateCodec = t.union([
    t.type({
        state: t.literal('not_found')
    }),
    t.type({
        state: t.literal('initing'),
        name: t.string,
        url: t.string,
        testnet: t.boolean,
        created: t.number,
        updated: t.number,
        revoked: t.boolean
    }),
    t.type({
        state: t.literal('ready'),
        name: t.string,
        url: t.string,
        wallet: t.type({
            address: t.string,
            endpoint: t.string,
            walletConfig: t.string,
            walletType: t.string,
            walletSig: t.string,
            appPublicKey: t.string
        }),
        testnet: t.boolean,
        created: t.number,
        updated: t.number,
        revoked: t.boolean
    })
]);

const jobStateCodec = t.union([t.type({
    state: t.union([t.literal('submitted'), t.literal('expired'), t.literal('rejected')]),
    job: t.string,
    created: t.number,
    updated: t.number,
    now: t.number
}), t.type({
    state: t.literal('completed'),
    job: t.string,
    created: t.number,
    updated: t.number,
    result: t.string,
    now: t.number
}), t.type({
    state: t.literal('empty'),
    now: t.number
})]);

export type TonhubWalletConfig = {
    address: string,
    endpoint: string,
    walletType: string,
    walletConfig: string,
    walletSig: string,
    appPublicKey: string
}

export type TonhubCreatedSession = {
    id: string
    seed: string,
    link: string
};

export type TonhubSessionStateRevoked = {
    state: 'revoked'
};

export type TonhubSessionStateExpired = {
    state: 'expired'
}

export type TonhubSessionStateReady = {
    state: 'ready',
    name: string,
    url: string,
    created: number,
    updated: number,
    wallet: TonhubWalletConfig
}

export type TonhubSessionStateIniting = {
    state: 'initing',
    name: string,
    url: string,
    created: number,
    updated: number
}

export type TonhubSessionState = TonhubSessionStateIniting | TonhubSessionStateRevoked | TonhubSessionStateReady;
export type TonhubSessionAwaited = TonhubSessionStateRevoked | TonhubSessionStateReady | TonhubSessionStateExpired;

export type TonhubTransactionRequest = {
    seed: string,
    appPublicKey: string,
    to: string,
    value: string,
    timeout: number,
    stateInit?: string | null | undefined,
    text?: string | null | undefined,
    payload?: string | null | undefined
};

export type TonhubTransactionResponse = {
    type: 'success',
    response: string
} | {
    type: 'rejected'
} | {
    type: 'expired'
} | {
    type: 'invalid_session'
};

export type TonhubSignRequest = {
    seed: string,
    appPublicKey: string,
    timeout: number,
    text?: string | null | undefined,
    payload?: string | null | undefined
}

export type TonhubSignResponse = {
    type: 'success',
    signature: string
} | {
    type: 'rejected'
} | {
    type: 'expired'
} | {
    type: 'invalid_session'
};

function idFromSeed(seed: string) {
    let keyPair = keyPairFromSeed(Buffer.from(seed, 'base64'));
    return toUrlSafe(keyPair.publicKey.toString('base64'));
}

export class TonhubConnector {

    static extractPublicKey(config: {
        walletType: string,
        walletConfig: string
    }) {
        // Extract public key and address
        let publicKey: Buffer;
        let restoredAddress: Address;
        if (config.walletType === 'org.ton.wallets.v4') {
            let source = WalletV4Source.restore(config.walletConfig);
            restoredAddress = contractAddress(source);
            publicKey = source.publicKey;
        } else {
            return null;
        }

        // Public key
        return { publicKey, address: restoredAddress };
    }

    static verifyWalletConfig(session: string, config: TonhubWalletConfig) {

        // Check address
        const address = Address.parseFriendly(config.address).address;

        // Extract public key and address
        let extracted = TonhubConnector.extractPublicKey(config);
        if (!extracted) {
            return false;
        }

        // Check address
        if (!extracted.address.equals(address)) {
            return false;
        }

        let publicKey: Buffer = extracted.publicKey;

        // Check signature
        let toSign = beginCell()
            .storeCoins(0)
            .storeBuffer(Buffer.from(session, 'base64'))
            .storeAddress(address)
            // Endpoint
            .storeBit(1)
            .storeRef(beginCell()
                .storeBuffer(Buffer.from(config.endpoint))
                .endCell())
            // App Public Key
            .storeRef(beginCell()
                .storeBuffer(Buffer.from(config.appPublicKey, 'base64'))
                .endCell())
            .endCell();

        // Sign
        return safeSignVerify(toSign, Buffer.from(config.walletSig, 'base64'), publicKey);
    }

    static verifySignatureResponse(args: {
        signature: string,
        text?: string | null | undefined,
        payload?: string | null | undefined,
        config: TonhubWalletConfig
    }) {
        // Check address
        const address = Address.parseFriendly(args.config.address).address;

        // Extract public key and address
        let extracted = TonhubConnector.extractPublicKey(args.config);
        if (!extracted) {
            return false;
        }

        // Check address
        if (!extracted.address.equals(address)) {
            return false;
        }

        let publicKey: Buffer = extracted.publicKey;

        // Package
        const textCell = new Cell();
        const payloadCell = new Cell();
        if (typeof args.text === 'string') {
            new CommentMessage(args.text).writeTo(textCell);
        }

        // Check signature
        const data = beginCell()
            .storeRef(textCell)
            .storeRef(payloadCell)
            .endCell();
        const signed = safeSignVerify(data, Buffer.from(args.signature, 'base64'), publicKey);

        return signed;
    }

    readonly testnet: boolean;
    readonly adapter: any | null;

    constructor(args?: { testnet?: boolean, adapter?: any }) {
        let testnet = false;
        let adapter: any | null = null;
        if (args) {
            if (typeof args.testnet === 'boolean') {
                testnet = args.testnet;
            }
            if (args.adapter) {
                adapter = args.adapter;
            }
        }
        this.testnet = testnet;
        this.adapter = adapter;
    }

    createNewSession = async (args: { name: string, url: string }): Promise<TonhubCreatedSession> => {

        // Generate new key
        let seed = await getSecureRandomBytes(32);
        let keyPair = keyPairFromSeed(seed);
        let sessionId = toUrlSafe(keyPair.publicKey.toString('base64'));

        // Request new session
        await backoff(async () => {
            let session = await axios.post('https://connect.tonhubapi.com/connect/init', {
                key: sessionId,
                testnet: this.testnet,
                name: args.name,
                url: args.url
            }, this.adapter ? { timeout: 5000, adapter: this.adapter } : { timeout: 5000 });
            if (!session.data.ok) {
                throw Error('Unable to create state');
            }
        });

        // Return session
        return {
            id: sessionId,
            seed: seed.toString('base64'),
            link: (this.testnet ? 'ton-test://connect/' : 'ton://connect/') + sessionId + '?endpoint=connect.tonhubapi.com'
        };
    }

    getSessionState = async (sessionId: string): Promise<TonhubSessionState> => {
        return await backoff(async () => {
            let ex = (await axios.get('https://connect.tonhubapi.com/connect/' + sessionId, this.adapter ? { timeout: 5000, adapter: this.adapter } : { timeout: 5000 })).data;
            if (!sessionStateCodec.is(ex)) {
                throw Error('Invalid response from server');
            }
            if (ex.state === 'initing') {
                if (ex.testnet !== this.testnet) {
                    return { state: 'revoked' };
                }
                return {
                    state: 'initing',
                    name: ex.name,
                    url: ex.url,
                    created: ex.created,
                    updated: ex.updated
                };
            }
            if (ex.state === 'ready') {
                if (ex.revoked) {
                    return { state: 'revoked' };
                }
                if (ex.testnet !== this.testnet) {
                    return { state: 'revoked' };
                }
                if (!TonhubConnector.verifyWalletConfig(sessionId, ex.wallet)) {
                    throw Error('Integrity check failed');
                }

                return {
                    state: 'ready',
                    name: ex.name,
                    url: ex.url,
                    created: ex.created,
                    updated: ex.updated,
                    wallet: {
                        address: ex.wallet.address,
                        endpoint: ex.wallet.endpoint,
                        walletType: ex.wallet.walletType,
                        walletConfig: ex.wallet.walletConfig,
                        walletSig: ex.wallet.walletSig,
                        appPublicKey: ex.wallet.appPublicKey
                    }
                };
            }

            return { state: 'revoked' };
        });
    }

    awaitSessionReady = async (sessionId: string, timeout: number): Promise<TonhubSessionAwaited> => {
        let expires = Date.now() + timeout;
        let res: TonhubSessionStateReady | TonhubSessionStateExpired | TonhubSessionStateRevoked = await backoff(async () => {
            while (Date.now() < expires) {
                let existing = await this.getSessionState(sessionId);
                if (existing.state !== 'initing') {
                    if (existing.state === 'ready') {
                        return existing;
                    } else if (existing.state === 'revoked') {
                        return existing;
                    }
                }
                await delay(1000);
            }
            return { state: 'expired' };
        });
        return res;
    }

    requestTransaction = async (request: TonhubTransactionRequest): Promise<TonhubTransactionResponse> => {
        const sessionId = idFromSeed(request.seed);

        // Check session
        let session = await backoff(() => this.getSessionState(sessionId));
        if (session.state !== 'ready') {
            return { type: 'invalid_session' };
        }
        if (session.wallet.appPublicKey !== request.appPublicKey) {
            return { type: 'invalid_session' };
        }

        // Parse address
        let address = Address.parseFriendly(request.to).address;

        // Value
        let value = new BN(request.value, 10);

        // Parse data
        let data: Cell | null = null;
        if (typeof request.payload === 'string') {
            data = Cell.fromBoc(Buffer.from(request.payload, 'base64'))[0];
        }

        // StateInit
        let stateInit: Cell | null = null;
        if (typeof request.stateInit === 'string') {
            data = Cell.fromBoc(Buffer.from(request.stateInit, 'base64'))[0];
        }

        // Comment
        let comment: string = '';
        if (typeof request.text === 'string') {
            comment = request.text;
        }

        // Prepare cell
        let expires = Math.floor((Date.now() + request.timeout) / 1000);
        let commentCell = new Cell();
        new CommentMessage(comment).writeTo(commentCell);
        const job = beginCell()
            .storeBuffer(Buffer.from(session.wallet.appPublicKey, 'base64'))
            .storeUint(expires, 32)
            .storeCoins(0)
            .storeRef(beginCell()
                .storeAddress(address)
                .storeCoins(value)
                .storeRef(commentCell)
                .storeRefMaybe(data ? data : null)
                .storeRefMaybe(stateInit ? stateInit : null)
                .endCell())
            .endCell()

        // Sign
        let keypair = keyPairFromSeed(Buffer.from(request.seed, 'base64'));
        let signature = safeSign(job, keypair.secretKey);

        // Create package
        let pkg = beginCell()
            .storeBuffer(signature)
            .storeBuffer(keypair.publicKey)
            .storeRef(job)
            .endCell();
        let boc = pkg.toBoc({ idx: false }).toString('base64');

        // Post command
        await backoff(() => axios.post('https://connect.tonhubapi.com/connect/command', { job: boc }, this.adapter ? { timeout: 5000, adapter: this.adapter } : { timeout: 5000 }));

        // Await result
        let result = await this._awaitJobState(request.appPublicKey, boc);
        if (result.type === 'completed') {
            return { type: 'success', response: result.result };
        } else if (result.type === 'rejected') {
            return { type: 'rejected' };
        }
        return { type: 'expired' };
    }

    requestSign = async (request: TonhubSignRequest): Promise<TonhubSignResponse> => {

        const sessionId = idFromSeed(request.seed);

        // Check session
        let session = await backoff(() => this.getSessionState(sessionId));
        if (session.state !== 'ready') {
            return { type: 'invalid_session' };
        }
        if (session.wallet.appPublicKey !== request.appPublicKey) {
            return { type: 'invalid_session' };
        }

        // Parse data
        let data: Cell = new Cell();
        if (typeof request.payload === 'string') {
            data = Cell.fromBoc(Buffer.from(request.payload, 'base64'))[0];
        }

        // Comment
        let comment: string = '';
        if (typeof request.text === 'string') {
            comment = request.text;
        }

        // Prepare cell
        let expires = Math.floor((Date.now() + request.timeout) / 1000);
        let commentCell = new Cell();
        new CommentMessage(comment).writeTo(commentCell);
        const job = beginCell()
            .storeBuffer(Buffer.from(session.wallet.appPublicKey, 'base64'))
            .storeUint(expires, 32)
            .storeCoins(1)
            .storeRef(beginCell()
                .storeRef(commentCell)
                .storeRef(data)
                .endCell())
            .endCell();

        // Sign
        let keypair = keyPairFromSeed(Buffer.from(request.seed, 'base64'));
        let signature = safeSign(job, keypair.secretKey);

        // Create package
        let pkg = beginCell()
            .storeBuffer(signature)
            .storeBuffer(keypair.publicKey)
            .storeRef(job)
            .endCell();
        let boc = pkg.toBoc({ idx: false }).toString('base64');

        // Post command
        await backoff(() => axios.post('https://connect.tonhubapi.com/connect/command', { job: boc }, this.adapter ? { timeout: 5000, adapter: this.adapter } : { timeout: 5000 }));

        // Await result
        let result = await this._awaitJobState(request.appPublicKey, boc);
        if (result.type === 'completed') {
            const cellRes = Cell.fromBoc(Buffer.from(result.result, 'base64'))[0];
            let slice = cellRes.beginParse();
            const resSignature = slice.readBuffer(64);
            let correct = TonhubConnector.verifySignatureResponse({ signature: resSignature.toString('base64'), config: session.wallet });
            if (correct) {
                return { type: 'success', signature: resSignature.toString('base64') };
            } else {
                return { type: 'rejected' };
            }
        } else if (result.type === 'rejected') {
            return { type: 'rejected' };
        }
        return { type: 'expired' };
    }

    private _awaitJobState = async (appPublicKey: string, boc: string): Promise<{ type: 'completed', result: string } | { type: 'rejected' | 'expired' }> => {
        return await backoff(async (): Promise<{ type: 'completed', result: string } | { type: 'rejected' | 'expired' }> => {
            while (true) {
                let state = await this._getJobState(appPublicKey, boc);
                if (state.type === 'expired') {
                    return { type: 'expired' };
                }
                if (state.type === 'completed') {
                    return { type: 'completed', result: state.result };
                }
                if (state.type === 'rejected') {
                    return { type: 'rejected' };
                }
                await delay(1000);
            }
        });
    }

    private _getJobState = async (appPublicKey: string, boc: string): Promise<{ type: 'expired' | 'rejected' | 'submitted' } | { type: 'completed', result: string }> => {
        let appk = toUrlSafe(appPublicKey);
        let res = (await axios.get('https://connect.tonhubapi.com/connect/command/' + appk, this.adapter ? { timeout: 5000, adapter: this.adapter } : { timeout: 5000 })).data;
        if (!jobStateCodec.is(res)) {
            throw Error('Invalid response from server');
        }
        if (res.state === 'empty') {
            return { type: 'expired' };
        }
        if (res.job !== boc) {
            return { type: 'rejected' };
        }
        if (res.state === 'expired') {
            return { type: 'expired' };
        }
        if (res.state === 'submitted') {
            return { type: 'submitted' };
        }
        if (res.state === 'rejected') {
            return { type: 'rejected' };
        }
        if (res.state === 'completed') {
            return { type: 'completed', result: res.result };
        }
        throw Error('Invalid response from server');
    };
}