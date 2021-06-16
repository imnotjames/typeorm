import {ObjectLiteral} from "../common/ObjectLiteral";
import {Connection} from "../connection/Connection";
import {OracleDriver} from "../driver/oracle/OracleDriver";
import {PostgresConnectionOptions} from "../driver/postgres/PostgresConnectionOptions";
import {MssqlParameter} from "../driver/sqlserver/MssqlParameter";
import {SqlServerConnectionOptions} from "../driver/sqlserver/SqlServerConnectionOptions";
import {SqlServerDriver} from "../driver/sqlserver/SqlServerDriver";
import {Table} from "../schema-builder/table/Table";
import {QueryResultCache} from "./QueryResultCache";
import {QueryResultCacheOptions} from "./QueryResultCacheOptions";

/**
 * Caches query result into current database, into separate table called "query-result-cache".
 */
export class DbQueryResultCache implements QueryResultCache {

    // -------------------------------------------------------------------------
    // Private properties
    // -------------------------------------------------------------------------

    private queryResultCacheTable: string;

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(protected connection: Connection) {

        const options = <SqlServerConnectionOptions|PostgresConnectionOptions>this.connection.driver.options;
        const cacheOptions = typeof this.connection.options.cache === "object" ? this.connection.options.cache : {};
        const cacheTableName = cacheOptions.tableName || "query-result-cache";

        this.queryResultCacheTable = this.connection.driver.buildTableName(cacheTableName, options.schema, options.database);
    }

    // -------------------------------------------------------------------------
    // Public Methods
    // -------------------------------------------------------------------------

    /**
     * Creates a connection with given cache provider.
     */
    async connect(): Promise<void> {
    }

    /**
     * Disconnects with given cache provider.
     */
    async disconnect(): Promise<void> {
    }

    /**
     * Creates table for storing cache if it does not exist yet.
     */
    async synchronize(): Promise<void> {
        const queryRunner = this.connection.createQueryRunner();

        const driver = this.connection.driver;

        try {
            const tableExist = await queryRunner.hasTable(this.queryResultCacheTable); // todo: table name should be configurable
            if (tableExist)
                return;

            await queryRunner.createTable(new Table(
                {
                    name: this.queryResultCacheTable,
                    columns: [
                        {
                            name: "id",
                            isPrimary: true,
                            isNullable: false,
                            type: driver.normalizeType({ type: driver.mappedDataTypes.cacheId }),
                            generationStrategy: "increment",
                            isGenerated: true
                        },
                        {
                            name: "identifier",
                            type: driver.normalizeType({ type: driver.mappedDataTypes.cacheIdentifier }),
                            isNullable: true
                        },
                        {
                            name: "time",
                            type: driver.normalizeType({ type: driver.mappedDataTypes.cacheTime }),
                            isPrimary: false,
                            isNullable: false
                        },
                        {
                            name: "duration",
                            type: driver.normalizeType({ type: driver.mappedDataTypes.cacheDuration }),
                            isPrimary: false,
                            isNullable: false
                        },
                        {
                            name: "query",
                            type: driver.normalizeType({ type: driver.mappedDataTypes.cacheQuery }),
                            isPrimary: false,
                            isNullable: false
                        },
                        {
                            name: "result",
                            type: driver.normalizeType({ type: driver.mappedDataTypes.cacheResult }),
                            isNullable: false
                        },
                    ]
                },
            ));
        } finally {
            await queryRunner.release();
        }
    }

    /**
     * Caches given query result.
     * Returns cache result if found.
     * Returns undefined if result is not cached.
     */
    async getFromCache(options: QueryResultCacheOptions): Promise<QueryResultCacheOptions|undefined> {
        const queryRunner = this.connection.createQueryRunner("slave");

        let result: QueryResultCacheOptions|undefined;

        try {
            const qb = this.connection
                .createQueryBuilder(queryRunner)
                .select()
                .from(this.queryResultCacheTable, "cache");

            if (options.identifier) {
                result = await qb
                    .where(`${qb.escape("cache")}.${qb.escape("identifier")} = :identifier`)
                    .setParameters({ identifier: this.connection.driver instanceof SqlServerDriver ? new MssqlParameter(options.identifier, "nvarchar") : options.identifier })
                    .getRawOne();

            } else if (options.query) {
                if (this.connection.driver instanceof OracleDriver) {
                    result = await qb
                        .where(`dbms_lob.compare(${qb.escape("cache")}.${qb.escape("query")}, :query) = 0`, { query: options.query })
                        .getRawOne();
                } else {
                    result = await qb
                        .where(`${qb.escape("cache")}.${qb.escape("query")} = :query`)
                        .setParameters({ query: this.connection.driver instanceof SqlServerDriver ? new MssqlParameter(options.query, "nvarchar") : options.query })
                        .getRawOne();
                }
            }
        } finally {
            await queryRunner.release();
        }

        return result;
    }

    /**
     * Checks if cache is expired or not.
     */
    isExpired(savedCache: QueryResultCacheOptions): boolean {
        const duration = typeof savedCache.duration === "string" ? parseInt(savedCache.duration) : savedCache.duration;
        return ((typeof savedCache.time === "string" ? parseInt(savedCache.time as any) : savedCache.time)! + duration) < new Date().getTime();
    }

    /**
     * Stores given query result in the cache.
     */
    async storeInCache(options: QueryResultCacheOptions, savedCache: QueryResultCacheOptions|undefined): Promise<void> {
        const queryRunner = this.connection.createQueryRunner();

        try {
            let insertedValues: ObjectLiteral = options;
            if (this.connection.driver instanceof SqlServerDriver) { // todo: bad abstraction, re-implement this part, probably better if we create an entity metadata for cache table
                insertedValues = {
                    identifier: new MssqlParameter(options.identifier, "nvarchar"),
                    time: new MssqlParameter(options.time, "bigint"),
                    duration: new MssqlParameter(options.duration, "int"),
                    query: new MssqlParameter(options.query, "nvarchar"),
                    result: new MssqlParameter(options.result, "nvarchar"),
                };
            }

            if (savedCache && savedCache.identifier) { // if exist then update
                const qb = queryRunner.manager
                    .createQueryBuilder()
                    .update(this.queryResultCacheTable)
                    .set(insertedValues);

                qb.where(`${qb.escape("identifier")} = :condition`, { condition: insertedValues.identifier });
                await qb.execute();

            } else if (savedCache && savedCache.query) { // if exist then update
                const qb = queryRunner.manager
                    .createQueryBuilder()
                    .update(this.queryResultCacheTable)
                    .set(insertedValues);

                if (this.connection.driver instanceof OracleDriver) {
                    qb.where(`dbms_lob.compare("query", :condition) = 0`, { condition: insertedValues.query });

                } else {
                    qb.where(`${qb.escape("query")} = :condition`, { condition: insertedValues.query });
                }

                await qb.execute();

            } else { // otherwise insert
                await queryRunner.manager
                    .createQueryBuilder()
                    .insert()
                    .into(this.queryResultCacheTable)
                    .values(insertedValues)
                    .execute();
            }
        } finally {
            await queryRunner.release();
        }
    }

    /**
     * Clears everything stored in the cache.
     */
    async clear(): Promise<void> {
        const queryRunner = this.connection.createQueryRunner();

        try {
            await queryRunner.clearTable(this.queryResultCacheTable);
        } finally {
            await queryRunner.release();
        }
    }

    /**
     * Removes all cached results by given identifiers from cache.
     */
    async remove(identifiers: string[]): Promise<void> {
        const queryRunner = this.connection.createQueryRunner();

        try {
            await Promise.all(identifiers.map(identifier => {
                const qb = this.connection.createQueryBuilder(queryRunner);

                return qb.delete()
                    .from(this.queryResultCacheTable)
                    .where(`${qb.escape("identifier")} = :identifier`, { identifier })
                    .execute();
            }));
        } finally {
            await queryRunner.release();
        }
    }
}
