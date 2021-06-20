import { DatabaseType } from "../driver/types/DatabaseType";
import { ConnectionMetadataOptions } from "./ConnectionMetadataOptions";

/**
 * BaseConnectionOptions is set of connection options shared by all database types.
 */
export interface BaseConnectionOptions extends ConnectionMetadataOptions {

    /**
     * Database type. This value is required.
     */
    readonly type: DatabaseType;

    /**
     * Maximum number of milliseconds query should be executed before logger log a warning.
     */
    readonly maxQueryExecutionTime?: number;

    /**
     * Indicates if database schema should be auto created on every application launch.
     * Be careful with this option and don't use this in production - otherwise you can lose production data.
     * This option is useful during debug and development.
     * Alternative to it, you can use CLI and run schema:sync command.
     *
     * Note that for MongoDB database it does not create schema, because MongoDB is schemaless.
     * Instead, it syncs just by creating indices.
     */
    readonly synchronize?: boolean;

    /**
     * Indicates if migrations should be auto run on every application launch.
     * Alternative to it, you can use CLI and run migrations:run command.
     */
    readonly migrationsRun?: boolean;

    /**
     * Drops the schema each time connection is being established.
     * Be careful with this option and don't use this in production - otherwise you'll lose all production data.
     * This option is useful during debug and development.
     */
    readonly dropSchema?: boolean;

    /**
     * Prefix to use on all tables (collections) of this connection in the database.
     */
    readonly entityPrefix?: string;

    /**
     * When creating new Entity instances, skip all constructors when true.
     */
    readonly entitySkipConstructor?: boolean;

    /**
     * Extra connection options to be passed to the underlying driver.
     *
     * todo: deprecate this and move all database-specific types into hts own connection options object.
     */
    readonly extra?: any;
}
