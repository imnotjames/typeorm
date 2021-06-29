import "reflect-metadata";
import {expect} from "chai";
import {createTestingConnections, closeTestingConnections} from "../../utils/test-utils";
import {Connection} from "../../../src";
import {Example} from "./entity/Example";

describe("github issues > #7084 duplicate enum leads to an unhelpful error message", () => {
    let connections: Connection[];
    before(async () => connections = await createTestingConnections({
        enabledDrivers: ["postgres"],
        schemaCreate: false,
        dropSchema: true,
        entities: [Example],
    }));
    after(() => closeTestingConnections(connections));

    it("should recognize model changes", () => Promise.all(connections.map(async connection => {
        const sqlInMemory = await connection.driver.createSchemaBuilder().log();
        expect(sqlInMemory.upQueries).to.eql([""])
        expect(sqlInMemory.downQueries).to.eql([""]);
    })));
});
