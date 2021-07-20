import "reflect-metadata";
import {
    closeTestingConnections,
    createTestingConnections,
    reloadTestingDatabases,
    setupSingleTestingConnection
} from "../../utils/test-utils";
import { Connection, createConnection } from "../../../src";
import { fail } from "assert";

describe("github issues > #5119 migration with foreign key that changes target", () => {
    let connections: Connection[];
    before(
        async () =>
            (connections = await createTestingConnections({
                entities: [__dirname + "/entity/v1/*{.js,.ts}"],
                enabledDrivers: ["postgres"],
            }))
    );
    beforeEach(() => reloadTestingDatabases(connections));
    after(() => closeTestingConnections([...connections]));

    it("should generate a drop and create step", async () => {
        return Promise.all(
            connections.map(async function(_connection) {
                const options = setupSingleTestingConnection(
                    _connection.options.type,
                    {
                        name: `${_connection.name}-v2`,
                        entities: [__dirname + "/entity/v2/*{.js,.ts}"],
                        dropSchema: false,
                        schemaCreate: false
                    }
                );
                if (!options) {
                    fail();
                    return;
                }
                const connection = await createConnection(options);
                try {
                    const sqlInMemory = await connection.driver
                        .createSchemaBuilder()
                        .log();

                    const upQueries = sqlInMemory.upQueries.map(
                        query => query.query
                    );
                    const downQueries = sqlInMemory.downQueries.map(
                        query => query.query
                    );
                    upQueries.should.eql([
                        `ALTER TABLE "public"."post" DROP CONSTRAINT "FK_4490d00e1925ca046a1f52ddf04"`,
                        `CREATE TABLE "public"."account" ("id" SERIAL NOT NULL, "userId" integer, CONSTRAINT "PK_54115ee388cdb6d86bb4bf5b2ea" PRIMARY KEY ("id"))`,
                        `ALTER TABLE "public"."account" ADD CONSTRAINT "FK_60328bf27019ff5498c4b977421" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
                        `ALTER TABLE "public"."post" ADD CONSTRAINT "FK_4490d00e1925ca046a1f52ddf04" FOREIGN KEY ("ownerId") REFERENCES "public"."account"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
                    ]);
                    downQueries.should.eql([
                        `ALTER TABLE "public"."post" ADD CONSTRAINT "FK_4490d00e1925ca046a1f52ddf04" FOREIGN KEY ("ownerId") REFERENCES "public"."user"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
                        `DROP TABLE "public"."account"`,
                        `ALTER TABLE "public"."account" DROP CONSTRAINT "FK_60328bf27019ff5498c4b977421"`,
                        `ALTER TABLE "public"."post" DROP CONSTRAINT "FK_4490d00e1925ca046a1f52ddf04"`
                    ]);
                } finally {
                    connection.close();
                }
            })
        );
    });
});
