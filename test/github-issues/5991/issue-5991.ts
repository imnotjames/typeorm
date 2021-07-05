import "reflect-metadata";
import {closeTestingConnections, createTestingConnections, reloadTestingDatabases} from "../../utils/test-utils";
import {Connection} from "../../../src/connection/Connection";
import {expect} from "chai";
import {Example} from "./entity/Example";
import { ExampleSubscriber } from "./subscriber/ExampleSubscriber";

describe("github issues > #5991 EntitySubscriber not awaiting", () => {
    let connections: Connection[];
    before(async () => connections = await createTestingConnections({
        entities: [Example],
        subscribers: [ExampleSubscriber],
        enabledDrivers: ["sqlite"],
    }));
    beforeEach(() => reloadTestingDatabases(connections));
    after(() => closeTestingConnections(connections));

    it("should fire the given event for an abstract entity", () => Promise.all(connections.map(async connection => {
        ExampleSubscriber.events.length = 0;

        const entity = new Example();

        await connection.manager.save(entity);

        expect(ExampleSubscriber.events).to.eql([
            "start before",
            "timeout before",
            "end before",
            "start after",
        ]);
    })));

});
