import {EntitySubscriberInterface, EventSubscriber, InsertEvent, UpdateEvent} from "../../../../src/index";
import {Example} from "../entity/Example";

@EventSubscriber()
export class ExampleSubscriber implements EntitySubscriberInterface<Example> {
    public static readonly events: string[] = []

    listenTo() {
        return Example;
    }

    async beforeInsert(event: InsertEvent<Example>) {
        ExampleSubscriber.events.push("start before");

        await new Promise<void>((resolve) => {
            setTimeout(() => {
                ExampleSubscriber.events.push("timeout before");
                resolve();
            }, 1000);
        })

        ExampleSubscriber.events.push("end before");
    }

    async afterInsert(event: UpdateEvent<Example>) {
        ExampleSubscriber.events.push("start after");
    }
}
