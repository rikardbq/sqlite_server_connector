// migrator.ts
/**
 * Migrator for sqlite_server
 * ---
 * Sets up and runs migrations
 *  - runs inline js migrations and keeps state of applied migrations
 *  - leveraging the Connector class for signing the token and making the request to the server
 */
import {
    ensureMigrationsState,
    generateMigrationObject,
    getOrDefaultMigrationsState,
    getStateFilePath,
    MIGRATION_APPLIED,
    MIGRATION_DUPLICATE_ENTRY,
    MIGRATION_FAILED,
    MIGRATION_STATE_WRITE_ERROR,
    MIGRATIONS_NO_MIGRATIONS,
    MIGRATIONS_PATH_NOT_SET,
    writeMigrationsState,
} from "util";
import { Connector } from "./connector.ts";
import { type Migration, Sub } from "./util/types.ts";
import { requestCallSymbol } from "./util/symbols.ts";

export class Migrator {
    private migrationsPath: string;
    private appliedMigrations: string[];
    private migrations: Migration[] = [];

    private constructor(migrationsPath: string, appliedMigrations: string[]) {
        this.migrationsPath = migrationsPath;
        this.appliedMigrations = appliedMigrations;
    }

    static async init(
        migrationsPath: string,
    ): Promise<Migrator> {
        if (!migrationsPath) {
            const { message, cause } = MIGRATIONS_PATH_NOT_SET;
            throw Error(
                message,
                { cause },
            );
        }

        await ensureMigrationsState(migrationsPath);

        const { __applied_migrations__: appliedMigrations } =
            await getOrDefaultMigrationsState(
                migrationsPath,
            );

        return new Migrator(
            migrationsPath,
            appliedMigrations,
        );
    }

    migration(
        name: string,
        query: string | string[],
    ) {
        const migration = generateMigrationObject(name, query);

        if (
            this.migrations.some(({ name }: Migration) =>
                migration.name === name
            )
        ) {
            const { message, cause } = MIGRATION_DUPLICATE_ENTRY;
            throw Error(
                `Duplicate \"${migration.name}\". ${message}`,
                { cause },
            );
        }

        this.migrations.push(migration);

        return this;
    }

    private async apply(
        connector: Connector,
        appliedMigrations: string[],
        migrations: Migration[],
    ): Promise<void> {
        if (migrations.length === 0) {
            return;
        }

        const [migrationToApply, ...restMigrations] = migrations;
        const response = await connector[requestCallSymbol](
            Sub.MIGRATE,
            migrationToApply,
            { pathParam: "/m" },
        );

        if (response.data === true) {
            console.info(MIGRATION_APPLIED);
            console.table(migrationToApply);

            const stateFilePath = getStateFilePath(this.migrationsPath);
            const appliedMigrationsState = [
                ...appliedMigrations,
                migrationToApply.name,
            ];
            try {
                await writeMigrationsState(
                    stateFilePath,
                    appliedMigrationsState,
                );

                return await this.apply(
                    connector,
                    appliedMigrationsState,
                    restMigrations,
                );
            } catch (_error) {
                console.error(MIGRATION_STATE_WRITE_ERROR);
                console.error(
                    `------------\n${stateFilePath}\n------------\n${
                        JSON.stringify(migrationToApply.name)
                    }`,
                );
            }
        } else {
            console.error(MIGRATION_FAILED);
            console.table(migrationToApply);
            throw Error(MIGRATION_FAILED);
        }
    }

    async run(connector: Connector) {
        try {
            const migrationsToApply = this.migrations.filter((
                { name }: Migration,
            ) => !this.appliedMigrations.includes(name));

            if (migrationsToApply.length > 0) {
                await this.apply(
                    connector,
                    this.appliedMigrations,
                    migrationsToApply,
                );
            } else {
                console.info(MIGRATIONS_NO_MIGRATIONS);
            }
        } catch (error) {
            console.error(error);
        }
    }
}

/**
 * EXAMPLE USAGE
const conn = await Connector.init("http://localhost:8080", {
    database: "helloworld",
    username: "rikard",
    password: "123",
});
const withMigrations = (m: Migrator) => {
    return m
        .migration(
            "first one",
            "INSERT INTO users(username, last_name) VALUES('rikardbq','Bergqvist');",
        )
        .migration(
            "the second one",
            [
                "ALTER TABLE users ADD COLUMN first_name TEXT;",
                "INSERT INTO users(username, last_name) VALUES('rikardbq2','Bergqvist2');",
            ],
        )
        .migration(
            "the third one",
            `
            "ALTER TABLE users ADD COLUMN last_last_name TEXT;",
            "INSERT INTO users(username, last_name) VALUES('rikardbq3','Bergqvist3');",
            `,
        );
};
const migrator = withMigrations(await Migrator.init("./migrations"));
await migrator.run(conn);
console.log(
    await conn.query("SELECT * FROM usors;"),
    await conn.query("SELECT * FROM __migrations_tracker_t__"),
);
*/
