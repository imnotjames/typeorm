import { expect } from "chai";
import { OrmUtils } from "../../../src/util/OrmUtils";

describe("OrmUtils.mergeDeep", () => {
    const mergeDeep = OrmUtils.mergeDeep.bind(OrmUtils);

    it("should handle simple values.", () => {
        expect(mergeDeep(1, 2)).to.equal(1);
        expect(mergeDeep(2, 1)).to.equal(2);
        expect(mergeDeep(2, 1, 1)).to.equal(2);
        expect(mergeDeep(1, 2, 1)).to.equal(1);
        expect(mergeDeep(1, 1, 2)).to.equal(1);
        expect(mergeDeep(2, 1, 2)).to.equal(2);
    });

    it("should handle ordering and indempotence.", () => {
        const a = { a: 1 };
        const b = { a: 2 };
        expect(mergeDeep(a, b)).to.deep.equal(b);
        expect(mergeDeep(b, a)).to.deep.equal(a);
        expect(mergeDeep(b, a, a)).to.deep.equal(a);
        expect(mergeDeep(a, b, a)).to.deep.equal(a);
        expect(mergeDeep(a, a, b)).to.deep.equal(b);
        expect(mergeDeep(b, a, b)).to.deep.equal(b);
        const c = { a: 3 };
        expect(mergeDeep(a, b, c)).to.deep.equal(c);
        expect(mergeDeep(b, c, b)).to.deep.equal(b);
        expect(mergeDeep(c, a, a)).to.deep.equal(a);
        expect(mergeDeep(c, b, a)).to.deep.equal(a);
        expect(mergeDeep(a, c, b)).to.deep.equal(b);
        expect(mergeDeep(b, a, c)).to.deep.equal(c);
    });

    it("should skip nested promises in sources.", () => {
        expect(mergeDeep({}, { p: Promise.resolve() })).to.deep.equal({});
        expect(mergeDeep({}, { p: { p: Promise.resolve() }})).to.deep.equal({ p: {} });
        const a = { p: Promise.resolve(0) };
        const b = { p: Promise.resolve(1) };
        expect(mergeDeep(a, {})).to.deep.equal(a);
        expect(mergeDeep(a, b)).to.deep.equal(a);
        expect(mergeDeep(b, a)).to.deep.equal(b);
        expect(mergeDeep(b, {})).to.deep.equal(b);
    });

    it("should merge moderately deep objects correctly.", () => {
        const a = { a: { b: { c: { d: { e: 123, h: { i: 23 } } } } }, g: 19 };
        const b = { a: { b: { c: { d: { f: 99 } }, f: 31 } } };
        const c = { a: { b: { c: { d: { e: 123, f: 99, h: { i: 23 } } }, f: 31 } }, g: 19 };
        expect(mergeDeep(a, b)).to.deep.equal(c);
        expect(mergeDeep(b, a)).to.deep.equal(c);
        expect(mergeDeep(b, a, a)).to.deep.equal(c);
        expect(mergeDeep(a, b, a)).to.deep.equal(c);
        expect(mergeDeep(a, a, b)).to.deep.equal(c);
        expect(mergeDeep(b, a, b)).to.deep.equal(c);
    });

    it("should reference copy complex instances of classes.", () => {
        class Foo {
            recursive: Foo;

            constructor() {
                this.recursive = this;
            }
        }

        const foo = new Foo();
        const result = mergeDeep({}, { foo });
        expect(result).to.have.property("foo");
        expect(result.foo).to.equal(foo);
    });
});
