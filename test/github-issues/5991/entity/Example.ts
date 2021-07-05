import { Entity, PrimaryGeneratedColumn } from "../../../../src";

@Entity()
export class Example {
    @PrimaryGeneratedColumn()
    id: number;
}
