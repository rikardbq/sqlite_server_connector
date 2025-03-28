// connector.ts
/**
 * Connector for sqlite_server
 * ---
 * Sets up connections according to ruleset where
 *  - request body to sqlite_server is signed using the username + password hash.
 *  - header is provided with username hash [ u_ ]
 *  - adding the correct subjects to claims MUTATE or FETCH, sent as [ M_, F_ ]
 */
import {
    decodeJWT,
    generateClaims,
    generateJWS,
    generateSHA256,
    verifyJWT,
} from "util";
import {
    type DatKind,
    type Error,
    type FetchResponse,
    type Migration,
    type MutationResponse,
    type Query,
    type ResultResponse,
    Sub,
} from "./util/types.ts";
import { requestCallSymbol } from "./util/symbols.ts";

const syntheticErrorResponse = (error: Error): ResultResponse => ({
    payload: null,
    error: {
        message: error.statusText ?? error.message ??
            "Something went wrong (unspecified error)",
        source: error.source ?? null,
    },
});

const handleResponse = async (
    res: Response,
    usernamePasswordHash: Uint8Array,
): Promise<DatKind> => {
    const json: ResultResponse = await res.json();

    if (json.error) {
        return json;
    }

    const payload = json.payload!;

    await verifyJWT(payload, usernamePasswordHash);
    const decoded = decodeJWT(payload);

    return decoded.dat;
};

type ConnectorInitOptions = {
    database: string;
    username: string;
    password: string;
};

export default class Connector {
    private [requestCallSymbol]: (
        sub: Sub,
        d: Query | Migration,
        opt?: {
            pathParam?: string;
        },
    ) => Promise<DatKind>;

    private constructor(
        fullAddr: string,
        usernameHash: string,
        usernamePasswordHash: Uint8Array,
    ) {
        this[requestCallSymbol] = this.prepare(
            fullAddr,
            usernameHash,
            usernamePasswordHash,
        );
    }

    /**
     * @param {string} addr
     * @param {ConnectorInitOptions} connectorInitOptions
     * @returns {Promise<Connector>} Promise containing new instance of Connector
     */
    static async init(
        addr: string,
        { database, username, password }: ConnectorInitOptions,
    ): Promise<Connector> {
        const encoder = new TextEncoder();
        const databaseLc = database.toLowerCase();
        const pattern = /[^a-z0-9_-]+/g;

        if (pattern.test(databaseLc)) {
            throw new Error(
                "Database name may only contain characters from these patterns: [a-z, 0-9, _-]",
            );
        }

        const databaseHash = await generateSHA256(databaseLc, encoder);
        const usernameHash = await generateSHA256(username, encoder);
        const usernamePasswordHash = await generateSHA256(
            username + password,
            encoder,
        );
        const fullAddr = `${addr}/${databaseHash}`;

        return new Connector(
            fullAddr,
            usernameHash,
            encoder.encode(usernamePasswordHash),
        );
    }

    /**
     * @param {string} fullAddr
     * @param {string} usernameHash
     * @param {string} usernamePasswordHash
     * @returns {(Sub, Query | Migration, object) => Promise<object>}
     */
    private prepare(
        fullAddr: string,
        usernameHash: string,
        usernamePasswordHash: Uint8Array,
    ): (
        sub: Sub,
        dat: Query | Migration,
        opt?: {
            pathParam?: string;
        },
    ) => Promise<DatKind> {
        const endpoint = fullAddr;
        const headers = {
            "content-type": "application/json",
            u_: usernameHash,
        };

        return async function (
            sub: Sub,
            dat: Query | Migration,
            opt?: {
                pathParam?: string;
            },
        ) {
            const optionalPathParam = opt?.pathParam ?? "";
            const claims = generateClaims(sub, dat);
            const jws = await generateJWS(claims, usernamePasswordHash);
            const body = JSON.stringify({
                payload: jws,
            });

            return handleResponse(
                await fetch(
                    new Request(endpoint + optionalPathParam, {
                        method: "POST",
                        body,
                        headers,
                    }),
                ),
                usernamePasswordHash,
            );
        };
    }

    /**
     * @param {string} query
     * @param {(number | string)[]} queryArgs
     * @returns {Promise<DatKind>} json data
     */
    async query(query: string, ...queryArgs: (number | string)[]) {
        try {
            return await this[requestCallSymbol](Sub.FETCH, {
                query,
                parts: queryArgs,
            }) as FetchResponse;
        } catch (error) {
            return syntheticErrorResponse(error as Error);
        }
    }

    /**
     * @param {string} query
     * @param {(number | string)[]} queryArgs
     * @returns {Promise<DatKind>} json data
     */
    async mutate(query: string, ...queryArgs: (number | string)[]) {
        try {
            return await this[requestCallSymbol](Sub.MUTATE, {
                query,
                parts: queryArgs,
            }) as MutationResponse;
        } catch (error) {
            return syntheticErrorResponse(error as Error);
        }
    }
}
