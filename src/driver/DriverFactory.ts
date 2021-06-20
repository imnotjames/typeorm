import {CockroachDriver} from "./cockroachdb/CockroachDriver";
import {MongoDriver} from "./mongodb/MongoDriver";
import {SqlServerDriver} from "./sqlserver/SqlServerDriver";
import {OracleDriver} from "./oracle/OracleDriver";
import {SqliteDriver} from "./sqlite/SqliteDriver";
import {CordovaDriver} from "./cordova/CordovaDriver";
import {ReactNativeDriver} from "./react-native/ReactNativeDriver";
import {NativescriptDriver} from "./nativescript/NativescriptDriver";
import {SqljsDriver} from "./sqljs/SqljsDriver";
import {MysqlDriver} from "./mysql/MysqlDriver";
import {PostgresDriver} from "./postgres/PostgresDriver";
import {ExpoDriver} from "./expo/ExpoDriver";
import {AuroraDataApiDriver} from "./aurora-data-api/AuroraDataApiDriver";
import {AuroraDataApiPostgresDriver} from "./aurora-data-api-pg/AuroraDataApiPostgresDriver";
import {Driver} from "./Driver";
import {Connection} from "../connection/Connection";
import {SapDriver} from "./sap/SapDriver";
import {BetterSqlite3Driver} from "./better-sqlite3/BetterSqlite3Driver";
import {CapacitorDriver} from "./capacitor/CapacitorDriver";
import {ConnectionOptions} from "../connection/ConnectionOptions";

/**
 * Helps to create drivers.
 */
export class DriverFactory {

    /**
     * Creates a new driver depend on a given connection's driver type.
     */
    create(connection: Connection, options: ConnectionOptions): Driver {
        switch (options.type) {
            case "mysql":
                return new MysqlDriver(connection, options);
            case "postgres":
                return new PostgresDriver(connection, options);
            case "cockroachdb":
                return new CockroachDriver(connection, options);
            case "sap":
                return new SapDriver(connection, options);
            case "mariadb":
                return new MysqlDriver(connection, options);
            case "sqlite":
                return new SqliteDriver(connection, options);
            case "better-sqlite3":
                return new BetterSqlite3Driver(connection, options);
            case "cordova":
                return new CordovaDriver(connection, options);
            case "nativescript":
                return new NativescriptDriver(connection, options);
            case "react-native":
                return new ReactNativeDriver(connection, options);
            case "sqljs":
                return new SqljsDriver(connection, options);
            case "oracle":
                return new OracleDriver(connection, options);
            case "mssql":
                return new SqlServerDriver(connection, options);
            case "mongodb":
                return new MongoDriver(connection, options);
            case "expo":
                return new ExpoDriver(connection, options);
            case "aurora-data-api":
                return new AuroraDataApiDriver(connection, options);
            case "aurora-data-api-pg":
                return new AuroraDataApiPostgresDriver(connection, options);
            case "capacitor":
                return new CapacitorDriver(connection, options);
        }
    }

}
