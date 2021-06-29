import { Column, Entity, PrimaryGeneratedColumn } from "../../../../src";

enum Enum1 {
    test = "test"
}

enum Enum2 {
    test = "test"
}

@Entity("test")
export class Example {
    @PrimaryGeneratedColumn()
    public id!: number;

    @Column("enum", {
        enum: Enum1,
        name: "enum1",
        nullable: false,
    })
    public provider!: Enum1;

    @Column("enum", {
        enum: Enum2,
        name: "enum1",
        nullable: false,
    })
    public method!: Enum2;
}
