/**
 * Thrown when a feature is attempted for a driver but it's not supported.
 */
import { Driver } from "../driver/Driver";

export class UnsupportedDriverFeature extends Error {
    name = "UnsupportedDriverFeature";

    constructor(driver: Driver, feature: string) {
        super();
        Object.setPrototypeOf(this, UnsupportedDriverFeature.prototype);
        this.message = `Unsupported Driver Feature (${driver.constructor.name}): ${feature}`;
    }

}
