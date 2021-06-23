import {ObjectLiteral} from "../common/ObjectLiteral";
import {Connection} from "../connection/Connection";
import {QueryExpressionMap} from "../query-builder/QueryExpressionMap";
import {EntityMetadata} from "../metadata/EntityMetadata";
import {ColumnMetadata} from "../metadata/ColumnMetadata";
import {PostgresDriver} from "../driver/postgres/PostgresDriver";
import {CockroachDriver} from "../driver/cockroachdb/CockroachDriver";
import {SqlServerDriver} from "../driver/sqlserver/SqlServerDriver";
import {OracleDriver} from "../driver/oracle/OracleDriver";
import {FindOperator} from "../find-options/FindOperator";
import {EntityColumnNotFound} from "../error/EntityColumnNotFound";
import { SelectQuery } from "../query-builder/SelectQuery";
import { MysqlDriver } from "../driver/mysql/MysqlDriver";
import { AuroraDataApiDriver } from "../driver/aurora-data-api/AuroraDataApiDriver";
import { SapDriver } from "../driver/sap/SapDriver";
import {
    InsertValuesMissingError, LimitOnUpdateNotSupportedError,
    LockNotSupportedOnGivenDriverError, MissingDeleteDateColumnError,
    OffsetWithoutLimitNotSupportedError, UpdateValuesMissingError,
} from "../error";
import { AbstractSqliteDriver } from "../driver/sqlite-abstract/AbstractSqliteDriver";
import { DriverUtils } from "../driver/DriverUtils";
import { RandomGenerator } from "../util/RandomGenerator";
import { WhereClause, WhereClauseCondition } from "../query-builder/WhereClause";

// todo: completely cover query builder with tests
// todo: entityOrProperty can be target name. implement proper behaviour if it is.
// todo: check in persistment if id exist on object and throw exception (can be in partial selection?)
// todo: fix problem with long aliases eg getMaxIdentifierLength
// todo: fix replacing in .select("COUNT(post.id) AS cnt") statement
// todo: implement joinAlways in relations and relationId
// todo: finish partial selection
// todo: sugar methods like: .addCount and .selectCount, selectCountAndMap, selectSum, selectSumAndMap, ...
// todo: implement @Select decorator
// todo: add select and map functions

// todo: implement relation/entity loading and setting them into properties within a separate query
// .loadAndMap("post.categories", "post.categories", qb => ...)
// .loadAndMap("post.categories", Category, qb => ...)

/**
 * Allows to build complex sql queries in a fashion way and execute those queries.
 */
export class QueryCompiler {

    // -------------------------------------------------------------------------
    // Public Properties
    // -------------------------------------------------------------------------

    /**
     * Connection on which QueryBuilder was created.
     */
    private readonly connection: Connection;

    /**
     * Contains all properties of the QueryBuilder that needs to be build a final query.
     */
    private readonly expressionMap: QueryExpressionMap;

    /**
     * QueryBuilder can be initialized from given Connection and QueryRunner objects or from given other QueryBuilder.
     */
    constructor(connection: Connection, expressionMap: QueryExpressionMap) {
        this.connection = connection;
        this.expressionMap = expressionMap;
    }

    // -------------------------------------------------------------------------
    // Public Methods
    // -------------------------------------------------------------------------

    /**
     * Gets generated sql that will be executed.
     * Parameters in the query are escaped for the currently used driver.
     */
    getSql(): string {
        switch (this.expressionMap.queryType) {
            // "select"|"update"|"delete"|"insert"|"relation"|"soft-delete"|"restore"

            case "select":
                return this.getSelectQuery();

            case "update":
                return this.getUpdateQuery();

            case "delete":
                return this.getDeleteQuery();

            case "insert":
                return this.getInsertQuery();

            case "relation":
                return this.getRelationQuery();

            case "soft-delete":
                return this.getSoftDeleteQuery();

            case "restore":
                return this.getRestoreQuery();
        }
    }

    /**
     * Escapes table name, column name or alias name using current database's escaping character.
     */
    protected escape(name: string): string {
        if (!this.expressionMap.disableEscaping)
            return name;
        return this.connection.driver.escape(name);
    }

    /**
     * Gets escaped table name with schema name if SqlServer driver used with custom
     * schema name, otherwise returns escaped table name.
     */
    protected getTableName(tablePath: string): string {
        return tablePath.split(".")
            .map(i => {
                // this condition need because in SQL Server driver when custom database name was specified and schema name was not, we got `dbName..tableName` string, and doesn't need to escape middle empty string
                if (i === "")
                    return i;
                return this.escape(i);
            }).join(".");
    }

    /**
     * Gets name of the table where insert should be performed.
     */
    protected getMainTableName(): string {
        if (!this.expressionMap.mainAlias)
            throw new Error(`Entity where values should be inserted is not specified. Call "qb.into(entity)" method to specify it.`);

        if (this.expressionMap.mainAlias.hasMetadata)
            return this.expressionMap.mainAlias.metadata.tablePath;

        return this.expressionMap.mainAlias.tablePath!;
    }

    /**
     * Replaces all entity's propertyName to name in the given statement.
     */
    protected replacePropertyNames(statement: string) {
        // Escape special characters in regular expressions
        // Per https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions#Escaping
        const escapeRegExp = (s: String) => s.replace(/[.*+\-?^${}()|[\]\\]/g, "\\$&");

        for (const alias of this.expressionMap.aliases) {
            if (!alias.hasMetadata) continue;
            const replaceAliasNamePrefix = this.expressionMap.aliasNamePrefixingEnabled ? `${alias.name}.` : "";
            const replacementAliasNamePrefix = this.expressionMap.aliasNamePrefixingEnabled ? `${this.escape(alias.name)}.` : "";

            const replacements: { [key: string]: string } = {};

            // Insert & overwrite the replacements from least to most relevant in our replacements object.
            // To do this we iterate and overwrite in the order of relevance.
            // Least to Most Relevant:
            // * Relation Property Path to first join column key
            // * Relation Property Path + Column Path
            // * Column Database Name
            // * Column Propety Name
            // * Column Property Path

            for (const relation of alias.metadata.relations) {
                if (relation.joinColumns.length > 0)
                    replacements[relation.propertyPath] = relation.joinColumns[0].databaseName;
            }

            for (const relation of alias.metadata.relations) {
                for (const joinColumn of [...relation.joinColumns, ...relation.inverseJoinColumns]) {
                    const propertyKey = `${relation.propertyPath}.${joinColumn.referencedColumn!.propertyPath}`;
                    replacements[propertyKey] = joinColumn.databaseName;
                }
            }

            for (const column of alias.metadata.columns) {
                replacements[column.databaseName] = column.databaseName;
            }

            for (const column of alias.metadata.columns) {
                replacements[column.propertyName] = column.databaseName;
            }

            for (const column of alias.metadata.columns) {
                replacements[column.propertyPath] = column.databaseName;
            }

            const replacementKeys = Object.keys(replacements);

            if (replacementKeys.length) {
                statement = statement.replace(new RegExp(
                    // Avoid a lookbehind here since it's not well supported
                    `([ =\(]|^.{0})` +
                    `${escapeRegExp(replaceAliasNamePrefix)}(${replacementKeys.map(escapeRegExp).join("|")})` +
                    `(?=[ =\)\,]|.{0}$)`,
                    "gm"
                    ), (_, pre, p) =>
                        `${pre}${replacementAliasNamePrefix}${this.escape(replacements[p])}`
                );
            }
        }

        return statement;
    }

    protected createComment(): string {
        if (!this.expressionMap.comment) {
            return "";
        }

        // ANSI SQL 2003 support C style comments - comments that start with `/*` and end with `*/`
        // In some dialects query nesting is available - but not all.  Because of this, we'll need
        // to scrub "ending" characters from the SQL but otherwise we can leave everything else
        // as-is and it should be valid.

        return `/* ${this.expressionMap.comment.replace("*/", "")} */ `;
    }

    /**
     * Creates "WHERE" expression.
     */
    protected createWhereExpression() {
        const conditionsArray = [];

        const whereExpression = this.createWhereClausesExpression(this.expressionMap.wheres);

        if (whereExpression.length > 0 && whereExpression !== "1=1") {
            conditionsArray.push(this.replacePropertyNames(whereExpression));
        }

        if (this.expressionMap.mainAlias!.hasMetadata) {
            const metadata = this.expressionMap.mainAlias!.metadata;
            // Adds the global condition of "non-deleted" for the entity with delete date columns in select query.
            if (this.expressionMap.queryType === "select" && !this.expressionMap.withDeleted && metadata.deleteDateColumn) {
                const column = this.expressionMap.aliasNamePrefixingEnabled
                    ? this.expressionMap.mainAlias!.name + "." + metadata.deleteDateColumn.propertyName
                    : metadata.deleteDateColumn.propertyName;

                const condition = `${this.replacePropertyNames(column)} IS NULL`;
                conditionsArray.push(condition);
            }

            if (metadata.discriminatorColumn && metadata.parentEntityMetadata) {
                const column = this.expressionMap.aliasNamePrefixingEnabled
                    ? this.expressionMap.mainAlias!.name + "." + metadata.discriminatorColumn.databaseName
                    : metadata.discriminatorColumn.databaseName;

                const condition = `${this.replacePropertyNames(column)} IN (:...discriminatorColumnValues)`;
                conditionsArray.push(condition);
            }
        }

        if (this.expressionMap.extraAppendedAndWhereCondition) {
            const condition = this.replacePropertyNames(this.expressionMap.extraAppendedAndWhereCondition);
            conditionsArray.push(condition);
        }

        if (!conditionsArray.length) {
            return "";
        } else if (conditionsArray.length === 1) {
            return ` WHERE ${conditionsArray[0]}`;
        } else {
            return ` WHERE ( ${conditionsArray.join(" ) AND ( ")} )`;
        }
    }

    protected createWhereClausesExpression(clauses: WhereClause[]): string {
        return clauses.map((clause, index) => {
            const expression = this.createWhereConditionExpression(clause.condition);

            switch (clause.type) {
                case "and":
                    return (index > 0 ? "AND " : "") + expression;
                case "or":
                    return (index > 0 ? "OR " : "") + expression;
            }

            return expression;
        }).join(" ").trim();
    }

    /**
     * Computes given where argument - transforms to a where string all forms it can take.
     */
    protected createWhereConditionExpression(condition: WhereClauseCondition): string {
        if (typeof condition === "string")
            return condition;

        if (Array.isArray(condition)) {
            if (condition.length === 0) {
                return "1=1";
            }

            if (condition.length === 1) {
                return this.createWhereClausesExpression(condition);
            }

            return "(" + this.createWhereClausesExpression(condition) + ")";
        }

        const { driver } = this.connection;

        switch (condition.operator) {
            case "lessThan":
                return `${condition.parameters[0]} < ${condition.parameters[1]}`;
            case "lessThanOrEqual":
                return `${condition.parameters[0]} <= ${condition.parameters[1]}`;
            case "moreThan":
                return `${condition.parameters[0]} > ${condition.parameters[1]}`;
            case "moreThanOrEqual":
                return `${condition.parameters[0]} >= ${condition.parameters[1]}`;
            case "notEqual":
                return `${condition.parameters[0]} != ${condition.parameters[1]}`;
            case "equal":
                return `${condition.parameters[0]} = ${condition.parameters[1]}`;
            case "ilike":
                if (driver instanceof PostgresDriver || driver instanceof CockroachDriver) {
                    return `${condition.parameters[0]} ILIKE ${condition.parameters[1]}`;
                }

                return `UPPER(${condition.parameters[0]}) LIKE UPPER(${condition.parameters[1]})`;
            case "like":
                return `${condition.parameters[0]} LIKE ${condition.parameters[1]}`;
            case "between":
                return `${condition.parameters[0]} BETWEEN ${condition.parameters[1]} AND ${condition.parameters[2]}`;
            case "in":
                if (condition.parameters.length <= 1) {
                    return "0=1";
                }
                return `${condition.parameters[0]} IN (${condition.parameters.slice(1).join(", ")})`;
            case "any":
                return `${condition.parameters[0]} = ANY(${condition.parameters[1]})`;
            case "isNull":
                return `${condition.parameters[0]} IS NULL`;

            case "not":
                return `NOT(${this.createWhereConditionExpression(condition.condition)})`;
        }

        throw new TypeError(`Unsupported FindOperator ${FindOperator.constructor.name}`);
    }

    /**
     * Creates "RETURNING" / "OUTPUT" expression.
     */
    protected createReturningExpression(): string {
        const columns = this.getReturningColumns();
        const driver = this.connection.driver;

        // also add columns we must auto-return to perform entity updation
        // if user gave his own returning
        if (typeof this.expressionMap.returning !== "string" &&
            this.expressionMap.extraReturningColumns.length > 0 &&
            driver.isReturningSqlSupported()) {
            columns.push(...this.expressionMap.extraReturningColumns.filter(column => {
                return columns.indexOf(column) === -1;
            }));
        }

        if (columns.length) {
            let columnsExpression = columns.map(column => {
                const name = this.escape(column.databaseName);
                if (driver instanceof SqlServerDriver) {
                    if (this.expressionMap.queryType === "insert" || this.expressionMap.queryType === "update" || this.expressionMap.queryType === "soft-delete" || this.expressionMap.queryType === "restore") {
                        return "INSERTED." + name;
                    } else {
                        return this.escape(this.getMainTableName()) + "." + name;
                    }
                } else {
                    return name;
                }
            }).join(", ");

            if (driver instanceof OracleDriver) {
                columnsExpression += " INTO " + columns.map(column => {
                    const parameterName = "output_" + column.databaseName;
                    this.expressionMap.nativeParameters[parameterName] = { type: driver.columnTypeToNativeParameter(column.type), dir: driver.oracle.BIND_OUT };
                    return this.connection.driver.createParameter(parameterName, Object.keys(this.expressionMap.nativeParameters).length);
                }).join(", ");
            }

            if (driver instanceof SqlServerDriver) {
                if (this.expressionMap.queryType === "insert" || this.expressionMap.queryType === "update") {
                    columnsExpression += " INTO @OutputTable";
                }
            }

            return columnsExpression;

        } else if (typeof this.expressionMap.returning === "string") {
            return this.expressionMap.returning;
        }

        return "";
    }

    /**
     * If returning / output cause is set to array of column names,
     * then this method will return all column metadatas of those column names.
     */
    protected getReturningColumns(): ColumnMetadata[] {
        const columns: ColumnMetadata[] = [];
        if (Array.isArray(this.expressionMap.returning)) {
            (this.expressionMap.returning as string[]).forEach(columnName => {
                if (this.expressionMap.mainAlias!.hasMetadata) {
                    columns.push(...this.expressionMap.mainAlias!.metadata.findColumnsWithPropertyPath(columnName));
                }
            });
        }
        return columns;
    }

    protected getDeleteQuery() {
        let sql = this.createComment();
        sql += this.createDeleteExpression();
        return sql.trim();
    }

    /**
     * Creates DELETE express used to perform query.
     */
    protected createDeleteExpression() {
        const tableName = this.getTableName(this.getMainTableName());
        const whereExpression = this.createWhereExpression();
        const returningExpression = this.createReturningExpression();

        if (returningExpression && (this.connection.driver instanceof PostgresDriver || this.connection.driver instanceof CockroachDriver)) {
            return `DELETE FROM ${tableName}${whereExpression} RETURNING ${returningExpression}`;

        } else if (returningExpression !== "" && this.connection.driver instanceof SqlServerDriver) {
            return `DELETE FROM ${tableName} OUTPUT ${returningExpression}${whereExpression}`;

        } else {
            return `DELETE FROM ${tableName}${whereExpression}`;
        }
    }

    /**
     * Creates "SELECT FROM" part of SQL query.
     */
    protected createSelectExpression() {

        if (!this.expressionMap.mainAlias)
            throw new Error("Cannot build query because main alias is not set (call qb#from method)");

        // todo throw exception if selects or from is missing

        const allSelects: SelectQuery[] = [];
        const excludedSelects: SelectQuery[] = [];

        if (this.expressionMap.mainAlias.hasMetadata) {
            const metadata = this.expressionMap.mainAlias.metadata;
            allSelects.push(...this.buildEscapedEntityColumnSelects(this.expressionMap.mainAlias.name, metadata));
            excludedSelects.push(...this.findEntityColumnSelects(this.expressionMap.mainAlias.name, metadata));
        }

        // add selects from joins
        this.expressionMap.joinAttributes
            .forEach(join => {
                if (join.metadata) {
                    allSelects.push(...this.buildEscapedEntityColumnSelects(join.alias.name!, join.metadata));
                    excludedSelects.push(...this.findEntityColumnSelects(join.alias.name!, join.metadata));
                } else {
                    const hasMainAlias = this.expressionMap.selects.some(select => select.selection === join.alias.name);
                    if (hasMainAlias) {
                        allSelects.push({ selection: this.escape(join.alias.name!) + ".*" });
                        const excludedSelect = this.expressionMap.selects.find(select => select.selection === join.alias.name);
                        excludedSelects.push(excludedSelect!);
                    }
                }
            });

        // add all other selects
        this.expressionMap.selects
            .filter(select => excludedSelects.indexOf(select) === -1)
            .forEach(select => allSelects.push({ selection: this.replacePropertyNames(select.selection), aliasName: select.aliasName }));

        // if still selection is empty, then simply set it to all (*)
        if (allSelects.length === 0)
            allSelects.push({ selection: "*" });

        let lock: string = "";
        if (this.connection.driver instanceof SqlServerDriver) {
            switch (this.expressionMap.lockMode) {
                case "pessimistic_read":
                    lock = " WITH (HOLDLOCK, ROWLOCK)";
                    break;
                case "pessimistic_write":
                    lock = " WITH (UPDLOCK, ROWLOCK)";
                    break;
                case "dirty_read":
                    lock = " WITH (NOLOCK)";
                    break;
            }
        }

        // create a selection query
        const froms = this.expressionMap.aliases
            .filter(alias => alias.type === "from" && (alias.tablePath || alias.subQuery))
            .map(alias => {
                if (alias.subQuery)
                    return alias.subQuery + " " + this.escape(alias.name);

                return this.getTableName(alias.tablePath!) + " " + this.escape(alias.name);
            });

        const select = this.createSelectDistinctExpression();
        const selection = allSelects.map(select => select.selection + (select.aliasName ? " AS " + this.escape(select.aliasName) : "")).join(", ");

        return select + selection + " FROM " + froms.join(", ") + lock;
    }

    /**
     * Creates select | select distinct part of SQL query.
     */
    protected createSelectDistinctExpression(): string {
        const {selectDistinct, selectDistinctOn, maxExecutionTime} = this.expressionMap;
        const {driver} = this.connection;

        let select = "SELECT ";

        if (maxExecutionTime > 0) {
            if (driver instanceof MysqlDriver) {
                select += `/*+ MAX_EXECUTION_TIME(${ this.expressionMap.maxExecutionTime }) */ `;
            }
        }

        if (driver instanceof PostgresDriver && selectDistinctOn.length > 0) {
            const selectDistinctOnMap = selectDistinctOn.map(
                (on) => this.replacePropertyNames(on)
            ).join(", ");

            select = `SELECT DISTINCT ON (${selectDistinctOnMap}) `;
        } else if (selectDistinct) {
            select = "SELECT DISTINCT ";
        }

        return select;
    }

    /**
     * Creates "JOIN" part of SQL query.
     */
    protected createJoinExpression(): string {

        // examples:
        // select from owning side
        // qb.select("post")
        //     .leftJoinAndSelect("post.category", "category");
        // select from non-owning side
        // qb.select("category")
        //     .leftJoinAndSelect("category.post", "post");

        const joins = this.expressionMap.joinAttributes.map(joinAttr => {
            const relation = joinAttr.relation;
            const destinationTableName = joinAttr.tablePath;
            const destinationTableAlias = joinAttr.alias.name;
            let appendedCondition = joinAttr.condition ? " AND (" + joinAttr.condition + ")" : "";
            const parentAlias = joinAttr.parentAlias;

            // if join was build without relation (e.g. without "post.category") then it means that we have direct
            // table to join, without junction table involved. This means we simply join direct table.
            if (!parentAlias || !relation) {
                const destinationJoin = joinAttr.alias.subQuery ? joinAttr.alias.subQuery : this.getTableName(destinationTableName);
                return " " + joinAttr.direction + " JOIN " + destinationJoin + " " + this.escape(destinationTableAlias) +
                    (joinAttr.condition ? " ON " + this.replacePropertyNames(joinAttr.condition) : "");
            }

            // if real entity relation is involved
            if (relation.isManyToOne || relation.isOneToOneOwner) {

                // JOIN `category` `category` ON `category`.`id` = `post`.`categoryId`
                const condition = relation.joinColumns.map(joinColumn => {
                    return destinationTableAlias + "." + joinColumn.referencedColumn!.propertyPath + "=" +
                        parentAlias + "." + relation.propertyPath + "." + joinColumn.referencedColumn!.propertyPath;
                }).join(" AND ");

                return " " + joinAttr.direction + " JOIN " + this.getTableName(destinationTableName) + " " + this.escape(destinationTableAlias) + " ON " + this.replacePropertyNames(condition + appendedCondition);

            } else if (relation.isOneToMany || relation.isOneToOneNotOwner) {

                // JOIN `post` `post` ON `post`.`categoryId` = `category`.`id`
                const condition = relation.inverseRelation!.joinColumns.map(joinColumn => {
                    if (relation.inverseEntityMetadata.tableType === "entity-child" && relation.inverseEntityMetadata.discriminatorColumn) {
                        appendedCondition += " AND " + destinationTableAlias + "." + relation.inverseEntityMetadata.discriminatorColumn.databaseName + "='" + relation.inverseEntityMetadata.discriminatorValue + "'";
                    }

                    return destinationTableAlias + "." + relation.inverseRelation!.propertyPath + "." + joinColumn.referencedColumn!.propertyPath + "=" +
                        parentAlias + "." + joinColumn.referencedColumn!.propertyPath;
                }).join(" AND ");

                return " " + joinAttr.direction + " JOIN " + this.getTableName(destinationTableName) + " " + this.escape(destinationTableAlias) + " ON " + this.replacePropertyNames(condition + appendedCondition);

            } else { // means many-to-many
                const junctionTableName = relation.junctionEntityMetadata!.tablePath;

                const junctionAlias = joinAttr.junctionAlias;
                let junctionCondition = "", destinationCondition = "";

                if (relation.isOwning) {

                    junctionCondition = relation.joinColumns.map(joinColumn => {
                        // `post_category`.`postId` = `post`.`id`
                        return junctionAlias + "." + joinColumn.propertyPath + "=" + parentAlias + "." + joinColumn.referencedColumn!.propertyPath;
                    }).join(" AND ");

                    destinationCondition = relation.inverseJoinColumns.map(joinColumn => {
                        // `category`.`id` = `post_category`.`categoryId`
                        return destinationTableAlias + "." + joinColumn.referencedColumn!.propertyPath + "=" + junctionAlias + "." + joinColumn.propertyPath;
                    }).join(" AND ");

                } else {
                    junctionCondition = relation.inverseRelation!.inverseJoinColumns.map(joinColumn => {
                        // `post_category`.`categoryId` = `category`.`id`
                        return junctionAlias + "." + joinColumn.propertyPath + "=" + parentAlias + "." + joinColumn.referencedColumn!.propertyPath;
                    }).join(" AND ");

                    destinationCondition = relation.inverseRelation!.joinColumns.map(joinColumn => {
                        // `post`.`id` = `post_category`.`postId`
                        return destinationTableAlias + "." + joinColumn.referencedColumn!.propertyPath + "=" + junctionAlias + "." + joinColumn.propertyPath;
                    }).join(" AND ");
                }

                return " " + joinAttr.direction + " JOIN " + this.getTableName(junctionTableName) + " " + this.escape(junctionAlias) + " ON " + this.replacePropertyNames(junctionCondition) +
                    " " + joinAttr.direction + " JOIN " + this.getTableName(destinationTableName) + " " + this.escape(destinationTableAlias) + " ON " + this.replacePropertyNames(destinationCondition + appendedCondition);

            }
        });

        return joins.join(" ");
    }

    /**
     * Creates "GROUP BY" part of SQL query.
     */
    protected createGroupByExpression() {
        if (!this.expressionMap.groupBys || !this.expressionMap.groupBys.length) return "";
        return " GROUP BY " + this.replacePropertyNames(this.expressionMap.groupBys.join(", "));
    }

    /**
     * Creates "ORDER BY" part of SQL query.
     */
    protected createOrderByExpression() {
        const orderBys = this.expressionMap.allOrderBys;
        if (Object.keys(orderBys).length > 0)
            return " ORDER BY " + Object.keys(orderBys)
                .map(columnName => {
                    if (typeof orderBys[columnName] === "string") {
                        return this.replacePropertyNames(columnName) + " " + orderBys[columnName];
                    } else {
                        return this.replacePropertyNames(columnName) + " " + (orderBys[columnName] as any).order + " " + (orderBys[columnName] as any).nulls;
                    }
                })
                .join(", ");

        return "";
    }

    /**
     * Creates "LIMIT" and "OFFSET" parts of SQL query.
     */
    protected createLimitOffsetExpression(): string {
        // in the case if nothing is joined in the query builder we don't need to make two requests to get paginated results
        // we can use regular limit / offset, that's why we add offset and limit construction here based on skip and take values
        let offset: number|undefined = this.expressionMap.offset,
            limit: number|undefined = this.expressionMap.limit;
        if (!offset && !limit && this.expressionMap.joinAttributes.length === 0) {
            offset = this.expressionMap.skip;
            limit = this.expressionMap.take;
        }

        if (this.connection.driver instanceof SqlServerDriver) {
            // Due to a limitation in SQL Server's parser implementation it does not support using
            // OFFSET or FETCH NEXT without an ORDER BY clause being provided. In cases where the
            // user does not request one we insert a dummy ORDER BY that does nothing and should
            // have no effect on the query planner or on the order of the results returned.
            // https://dba.stackexchange.com/a/193799
            let prefix = "";
            if ((limit || offset) && Object.keys(this.expressionMap.allOrderBys).length <= 0) {
                prefix = " ORDER BY (SELECT NULL)";
            }

            if (limit && offset)
                return prefix + " OFFSET " + offset + " ROWS FETCH NEXT " + limit + " ROWS ONLY";
            if (limit)
                return prefix + " OFFSET 0 ROWS FETCH NEXT " + limit + " ROWS ONLY";
            if (offset)
                return prefix + " OFFSET " + offset + " ROWS";

        } else if (this.connection.driver instanceof MysqlDriver || this.connection.driver instanceof AuroraDataApiDriver || this.connection.driver instanceof SapDriver) {

            if (limit && offset)
                return " LIMIT " + limit + " OFFSET " + offset;
            if (limit)
                return " LIMIT " + limit;
            if (offset)
                throw new OffsetWithoutLimitNotSupportedError();

        } else if (this.connection.driver instanceof AbstractSqliteDriver) {

            if (limit && offset)
                return " LIMIT " + limit + " OFFSET " + offset;
            if (limit)
                return " LIMIT " + limit;
            if (offset)
                return " LIMIT -1 OFFSET " + offset;

        } else if (this.connection.driver instanceof OracleDriver) {

            if (limit && offset)
                return " OFFSET " + offset + " ROWS FETCH NEXT " + limit + " ROWS ONLY";
            if (limit)
                return " FETCH NEXT " + limit + " ROWS ONLY";
            if (offset)
                return " OFFSET " + offset + " ROWS";

        } else {
            if (limit && offset)
                return " LIMIT " + limit + " OFFSET " + offset;
            if (limit)
                return " LIMIT " + limit;
            if (offset)
                return " OFFSET " + offset;
        }

        return "";
    }

    /**
     * Creates "LOCK" part of SQL query.
     */
    protected createLockExpression(): string {
        const driver = this.connection.driver;

        let lockTablesClause = "";

        if (this.expressionMap.lockTables) {
            if (!(driver instanceof PostgresDriver)) {
                throw new Error("Lock tables not supported in selected driver");
            }
            if (this.expressionMap.lockTables.length < 1) {
                throw new Error("lockTables cannot be an empty array");
            }
            lockTablesClause = " OF " + this.expressionMap.lockTables.join(", ");
        }

        switch (this.expressionMap.lockMode) {
            case "pessimistic_read":
                if (driver instanceof MysqlDriver || driver instanceof AuroraDataApiDriver) {
                    return " LOCK IN SHARE MODE";

                } else if (driver instanceof PostgresDriver) {
                    return " FOR SHARE" + lockTablesClause;

                } else if (driver instanceof OracleDriver) {
                    return " FOR UPDATE";

                } else if (driver instanceof SqlServerDriver) {
                    return "";

                } else {
                    throw new LockNotSupportedOnGivenDriverError();
                }
            case "pessimistic_write":
                if (driver instanceof MysqlDriver || driver instanceof AuroraDataApiDriver || driver instanceof OracleDriver) {
                    return " FOR UPDATE";

                }
                else if (driver instanceof PostgresDriver ) {
                    return " FOR UPDATE" + lockTablesClause;

                } else if (driver instanceof SqlServerDriver) {
                    return "";

                } else {
                    throw new LockNotSupportedOnGivenDriverError();
                }
            case "pessimistic_partial_write":
                if (driver instanceof PostgresDriver) {
                    return " FOR UPDATE" + lockTablesClause + " SKIP LOCKED";

                } else if (driver instanceof MysqlDriver) {
                    return " FOR UPDATE SKIP LOCKED";

                } else {
                    throw new LockNotSupportedOnGivenDriverError();
                }
            case "pessimistic_write_or_fail":
                if (driver instanceof PostgresDriver) {
                    return " FOR UPDATE" + lockTablesClause + " NOWAIT";

                } else if (driver instanceof MysqlDriver) {
                    return " FOR UPDATE NOWAIT";

                } else {
                    throw new LockNotSupportedOnGivenDriverError();
                }

            case "for_no_key_update":
                if (driver instanceof PostgresDriver) {
                    return " FOR NO KEY UPDATE" + lockTablesClause;
                } else {
                    throw new LockNotSupportedOnGivenDriverError();
                }
            default:
                return "";
        }
    }

    /**
     * Creates "HAVING" part of SQL query.
     */
    protected createHavingExpression() {
        if (!this.expressionMap.havings || !this.expressionMap.havings.length) return "";
        const conditions = this.expressionMap.havings.map((having, index) => {
            switch (having.type) {
                case "and":
                    return (index > 0 ? "AND " : "") + this.replacePropertyNames(having.condition);
                case "or":
                    return (index > 0 ? "OR " : "") + this.replacePropertyNames(having.condition);
                default:
                    return this.replacePropertyNames(having.condition);
            }
        }).join(" ");

        if (!conditions.length) return "";
        return " HAVING " + conditions;
    }

    protected buildEscapedEntityColumnSelects(aliasName: string, metadata: EntityMetadata): SelectQuery[] {
        const hasMainAlias = this.expressionMap.selects.some(select => select.selection === aliasName);

        const columns: ColumnMetadata[] = [];
        if (hasMainAlias) {
            columns.push(...metadata.columns.filter(column => column.isSelect === true));
        }
        columns.push(...metadata.columns.filter(column => {
            return this.expressionMap.selects.some(select => select.selection === aliasName + "." + column.propertyPath);
        }));

        // if user used partial selection and did not select some primary columns which are required to be selected
        // we select those primary columns and mark them as "virtual". Later virtual column values will be removed from final entity
        // to make entity contain exactly what user selected
        if (columns.length === 0) // however not in the case when nothing (even partial) was selected from this target (for example joins without selection)
            return [];

        const nonSelectedPrimaryColumns = this.expressionMap.queryEntity ? metadata.primaryColumns.filter(primaryColumn => columns.indexOf(primaryColumn) === -1) : [];
        const allColumns = [...columns, ...nonSelectedPrimaryColumns];

        return allColumns.map(column => {
            const selection = this.expressionMap.selects.find(select => select.selection === aliasName + "." + column.propertyPath);
            let selectionPath = this.escape(aliasName) + "." + this.escape(column.databaseName);
            if (this.connection.driver.spatialTypes.indexOf(column.type) !== -1) {
                if (this.connection.driver instanceof MysqlDriver || this.connection.driver instanceof AuroraDataApiDriver) {
                    const useLegacy = this.connection.driver.options.legacySpatialSupport;
                    const asText = useLegacy ? "AsText" : "ST_AsText";
                    selectionPath = `${asText}(${selectionPath})`;
                }

                if (this.connection.driver instanceof PostgresDriver)
                    // cast to JSON to trigger parsing in the driver
                    if (column.precision) {
                        selectionPath = `ST_AsGeoJSON(${selectionPath}, ${column.precision})::json`;
                    } else {
                        selectionPath = `ST_AsGeoJSON(${selectionPath})::json`;
                    }
                if (this.connection.driver instanceof SqlServerDriver)
                    selectionPath = `${selectionPath}.ToString()`;
            }
            return {
                selection: selectionPath,
                aliasName: selection && selection.aliasName ? selection.aliasName : DriverUtils.buildAlias(this.connection.driver, aliasName, column.databaseName),
                // todo: need to keep in mind that custom selection.aliasName breaks hydrator. fix it later!
                virtual: selection ? selection.virtual === true : (hasMainAlias ? false : true),
            };
        });
    }

    protected findEntityColumnSelects(aliasName: string, metadata: EntityMetadata): SelectQuery[] {
        const mainSelect = this.expressionMap.selects.find(select => select.selection === aliasName);
        if (mainSelect)
            return [mainSelect];

        return this.expressionMap.selects.filter(select => {
            return metadata.columns.some(column => select.selection === aliasName + "." + column.propertyPath);
        });
    }

    /**
     * Creates INSERT express used to perform insert query.
     */
    protected createInsertExpression() {
        const tableName = this.getTableName(this.getMainTableName());
        const valuesExpression = this.createValuesExpression(); // its important to get values before returning expression because oracle rely on native parameters and ordering of them is important
        const returningExpression = (this.connection.driver instanceof OracleDriver && this.getValueSets().length > 1) ? null : this.createReturningExpression(); // oracle doesnt support returning with multi-row insert
        const columnsExpression = this.createColumnNamesExpression();
        let query = "INSERT ";

        if (this.connection.driver instanceof MysqlDriver || this.connection.driver instanceof AuroraDataApiDriver) {
            query += `${this.expressionMap.onIgnore ? " IGNORE " : ""}`;
        }

        query += `INTO ${tableName}`;

        // add columns expression
        if (columnsExpression) {
            query += `(${columnsExpression})`;
        } else {
            if (!valuesExpression && (this.connection.driver instanceof MysqlDriver || this.connection.driver instanceof AuroraDataApiDriver)) // special syntax for mysql DEFAULT VALUES insertion
                query += "()";
        }

        // add OUTPUT expression
        if (returningExpression && this.connection.driver instanceof SqlServerDriver) {
            query += ` OUTPUT ${returningExpression}`;
        }

        // add VALUES expression
        if (valuesExpression) {
            if (this.connection.driver instanceof OracleDriver && this.getValueSets().length > 1) {
                query += ` ${valuesExpression}`;
            } else {
                query += ` VALUES ${valuesExpression}`;
            }
        } else {
            if (this.connection.driver instanceof MysqlDriver || this.connection.driver instanceof AuroraDataApiDriver) { // special syntax for mysql DEFAULT VALUES insertion
                query += " VALUES ()";
            } else {
                query += ` DEFAULT VALUES`;
            }
        }
        if (this.connection.driver instanceof PostgresDriver || this.connection.driver instanceof AbstractSqliteDriver || this.connection.driver instanceof CockroachDriver) {
            query += `${this.expressionMap.onIgnore ? " ON CONFLICT DO NOTHING " : ""}`;
            query += `${this.expressionMap.onConflict ? " ON CONFLICT " + this.expressionMap.onConflict : ""}`;
            if (this.expressionMap.onUpdate) {
                const { overwrite, columns, conflict } = this.expressionMap.onUpdate;
                query += `${columns ? " ON CONFLICT " + conflict + " DO UPDATE SET " + columns : ""}`;
                query += `${overwrite ? " ON CONFLICT " + conflict + " DO UPDATE SET " + overwrite : ""}`;
            }
        } else if (this.connection.driver instanceof MysqlDriver || this.connection.driver instanceof AuroraDataApiDriver) {
            if (this.expressionMap.onUpdate) {
                const { overwrite, columns } = this.expressionMap.onUpdate;
                query += `${columns ? " ON DUPLICATE KEY UPDATE " + columns : ""}`;
                query += `${overwrite ? " ON DUPLICATE KEY UPDATE " + overwrite : ""}`;
            }
        }

        // add RETURNING expression
        if (returningExpression && (this.connection.driver instanceof PostgresDriver || this.connection.driver instanceof OracleDriver || this.connection.driver instanceof CockroachDriver)) {
            query += ` RETURNING ${returningExpression}`;
        }


        // Inserting a specific value for an auto-increment primary key in mssql requires enabling IDENTITY_INSERT
        // IDENTITY_INSERT can only be enabled for tables where there is an IDENTITY column and only if there is a value to be inserted (i.e. supplying DEFAULT is prohibited if IDENTITY_INSERT is enabled)
        if (this.connection.driver instanceof SqlServerDriver
            && this.expressionMap.mainAlias!.hasMetadata
            && this.expressionMap.mainAlias!.metadata.columns
                .filter((column) => this.expressionMap.insertColumns.length > 0 ? this.expressionMap.insertColumns.indexOf(column.propertyPath) !== -1 : column.isInsert)
                .some((column) => this.isOverridingAutoIncrementBehavior(column))
        ) {
            query = `SET IDENTITY_INSERT ${tableName} ON; ${query}; SET IDENTITY_INSERT ${tableName} OFF`;
        }

        return query;
    }

    /**
     * Gets list of columns where values must be inserted to.
     */
    protected getInsertedColumns(): ColumnMetadata[] {
        if (!this.expressionMap.mainAlias!.hasMetadata)
            return [];

        return this.expressionMap.mainAlias!.metadata.columns.filter(column => {

            // if user specified list of columns he wants to insert to, then we filter only them
            if (this.expressionMap.insertColumns.length)
                return this.expressionMap.insertColumns.indexOf(column.propertyPath) !== -1;

            // skip columns the user doesn't want included by default
            if (!column.isInsert) { return false; }

            // if user did not specified such list then return all columns except auto-increment one
            // for Oracle we return auto-increment column as well because Oracle does not support DEFAULT VALUES expression
            if (column.isGenerated && column.generationStrategy === "increment"
                && !(this.connection.driver instanceof OracleDriver)
                && !(this.connection.driver instanceof AbstractSqliteDriver)
                && !(this.connection.driver instanceof MysqlDriver)
                && !(this.connection.driver instanceof AuroraDataApiDriver)
                && !(this.connection.driver instanceof SqlServerDriver && this.isOverridingAutoIncrementBehavior(column)))
                return false;

            return true;
        });
    }

    /**
     * Creates a columns string where values must be inserted to for INSERT INTO expression.
     */
    protected createColumnNamesExpression(): string {
        const columns = this.getInsertedColumns();
        if (columns.length > 0)
            return columns.map(column => this.escape(column.databaseName)).join(", ");

        // in the case if there are no insert columns specified and table without metadata used
        // we get columns from the inserted value map, in the case if only one inserted map is specified
        if (!this.expressionMap.mainAlias!.hasMetadata && !this.expressionMap.insertColumns.length) {
            const valueSets = this.getValueSets();
            if (valueSets.length === 1)
                return Object.keys(valueSets[0]).map(columnName => this.escape(columnName)).join(", ");
        }

        // get a table name and all column database names
        return this.expressionMap.insertColumns.map(columnName => this.escape(columnName)).join(", ");
    }

    /**
     * Creates list of values needs to be inserted in the VALUES expression.
     */
    protected createValuesExpression(): string {
        const valueSets = this.getValueSets();
        const columns = this.getInsertedColumns();

        // if column metadatas are given then apply all necessary operations with values
        if (columns.length > 0) {
            let expression = "";
            let parametersCount = Object.keys(this.expressionMap.nativeParameters).length;
            valueSets.forEach((valueSet, valueSetIndex) => {
                columns.forEach((column, columnIndex) => {
                    if (columnIndex === 0) {
                        if (this.connection.driver instanceof OracleDriver && valueSets.length > 1) {
                            expression += " SELECT ";
                        } else {
                            expression += "(";
                        }
                    }
                    const paramName = "i" + valueSetIndex + "_" + column.databaseName;

                    // extract real value from the entity
                    let value = column.getEntityValue(valueSet);

                    // if column is relational and value is an object then get real referenced column value from this object
                    // for example column value is { question: { id: 1 } }, value will be equal to { id: 1 }
                    // and we extract "1" from this object
                    /*if (column.referencedColumn && value instanceof Object && !(value instanceof Function)) { // todo: check if we still need it since getEntityValue already has similar code
                        value = column.referencedColumn.getEntityValue(value);
                    }*/


                    if (!(value instanceof Function)) {
                        // make sure our value is normalized by a driver
                        value = this.connection.driver.preparePersistentValue(value, column);
                    }

                    // newly inserted entities always have a version equal to 1 (first version)
                    // also, user-specified version must be empty
                    if (column.isVersion && value === undefined) {
                        expression += "1";

                        // } else if (column.isNestedSetLeft) {
                        //     const tableName = this.connection.driver.escape(column.entityMetadata.tablePath);
                        //     const rightColumnName = this.connection.driver.escape(column.entityMetadata.nestedSetRightColumn!.databaseName);
                        //     const subQuery = `(SELECT c.max + 1 FROM (SELECT MAX(${rightColumnName}) as max from ${tableName}) c)`;
                        //     expression += subQuery;
                        //
                        // } else if (column.isNestedSetRight) {
                        //     const tableName = this.connection.driver.escape(column.entityMetadata.tablePath);
                        //     const rightColumnName = this.connection.driver.escape(column.entityMetadata.nestedSetRightColumn!.databaseName);
                        //     const subQuery = `(SELECT c.max + 2 FROM (SELECT MAX(${rightColumnName}) as max from ${tableName}) c)`;
                        //     expression += subQuery;

                    } else if (column.isDiscriminator) {
                        this.expressionMap.nativeParameters["discriminator_value_" + parametersCount] = this.expressionMap.mainAlias!.metadata.discriminatorValue;
                        expression += this.connection.driver.createParameter("discriminator_value_" + parametersCount, parametersCount);
                        parametersCount++;
                        // return "1";

                        // for create and update dates we insert current date
                        // no, we don't do it because this constant is already in "default" value of the column
                        // with extended timestamp functionality, like CURRENT_TIMESTAMP(6) for example
                        // } else if (column.isCreateDate || column.isUpdateDate) {
                        //     return "CURRENT_TIMESTAMP";

                        // if column is generated uuid and database does not support its generation and custom generated value was not provided by a user - we generate a new uuid value for insertion
                    } else if (column.isGenerated && column.generationStrategy === "uuid" && !this.connection.driver.isUUIDGenerationSupported() && value === undefined) {

                        const paramName = "uuid_" + column.databaseName + valueSetIndex;
                        value = RandomGenerator.uuid4();
                        this.expressionMap.nativeParameters[paramName] = value;
                        expression += this.connection.driver.createParameter(paramName, parametersCount);
                        parametersCount++;

                        // if value for this column was not provided then insert default value
                    } else if (value === undefined) {
                        if ((this.connection.driver instanceof OracleDriver && valueSets.length > 1) || this.connection.driver instanceof AbstractSqliteDriver || this.connection.driver instanceof SapDriver) { // unfortunately sqlite does not support DEFAULT expression in INSERT queries
                            if (column.default !== undefined && column.default !== null) { // try to use default defined in the column
                                expression += this.connection.driver.normalizeDefault(column);
                            } else {
                                expression += "NULL"; // otherwise simply use NULL and pray if column is nullable
                            }

                        } else {
                            expression += "DEFAULT";
                        }

                        // support for SQL expressions in queries
                    } else if (value instanceof Function) {
                        expression += value();

                        // just any other regular value
                    } else {
                        if (this.connection.driver instanceof SqlServerDriver)
                            value = this.connection.driver.parametrizeValue(column, value);

                        // we need to store array values in a special class to make sure parameter replacement will work correctly
                        // if (value instanceof Array)
                        //     value = new ArrayParameter(value);

                        this.expressionMap.nativeParameters[paramName] = value;
                        if ((this.connection.driver instanceof MysqlDriver || this.connection.driver instanceof AuroraDataApiDriver) && this.connection.driver.spatialTypes.indexOf(column.type) !== -1) {
                            const useLegacy = this.connection.driver.options.legacySpatialSupport;
                            const geomFromText = useLegacy ? "GeomFromText" : "ST_GeomFromText";
                            if (column.srid != null) {
                                expression += `${geomFromText}(${this.connection.driver.createParameter(paramName, parametersCount)}, ${column.srid})`;
                            } else {
                                expression += `${geomFromText}(${this.connection.driver.createParameter(paramName, parametersCount)})`;
                            }
                        } else if (this.connection.driver instanceof PostgresDriver && this.connection.driver.spatialTypes.indexOf(column.type) !== -1) {
                            if (column.srid != null) {
                                expression += `ST_SetSRID(ST_GeomFromGeoJSON(${this.connection.driver.createParameter(paramName, parametersCount)}), ${column.srid})::${column.type}`;
                            } else {
                                expression += `ST_GeomFromGeoJSON(${this.connection.driver.createParameter(paramName, parametersCount)})::${column.type}`;
                            }
                        } else if (this.connection.driver instanceof SqlServerDriver && this.connection.driver.spatialTypes.indexOf(column.type) !== -1) {
                            expression += column.type + "::STGeomFromText(" + this.connection.driver.createParameter(paramName, parametersCount) + ", " + (column.srid || "0") + ")";
                        } else {
                            expression += this.connection.driver.createParameter(paramName, parametersCount);
                        }
                        parametersCount++;
                    }

                    if (columnIndex === columns.length - 1) {
                        if (valueSetIndex === valueSets.length - 1) {
                            if (this.connection.driver instanceof OracleDriver && valueSets.length > 1) {
                                expression += " FROM DUAL ";
                            } else {
                                expression += ")";
                            }
                        } else {
                            if (this.connection.driver instanceof OracleDriver && valueSets.length > 1) {
                                expression += " FROM DUAL UNION ALL ";
                            } else {
                                expression += "), ";
                            }
                        }
                    } else {
                        expression += ", ";
                    }
                });
            });
            if (expression === "()")
                return "";

            return expression;
        } else { // for tables without metadata
            // get values needs to be inserted
            let expression = "";
            let parametersCount = Object.keys(this.expressionMap.nativeParameters).length;

            valueSets.forEach((valueSet, insertionIndex) => {
                const columns = Object.keys(valueSet);
                columns.forEach((columnName, columnIndex) => {
                    if (columnIndex === 0) {
                        expression += "(";
                    }
                    const paramName = "i" + insertionIndex + "_" + columnName;
                    const value = valueSet[columnName];

                    // support for SQL expressions in queries
                    if (value instanceof Function) {
                        expression += value();

                        // if value for this column was not provided then insert default value
                    } else if (value === undefined) {
                        if (this.connection.driver instanceof AbstractSqliteDriver || this.connection.driver instanceof SapDriver) {
                            expression += "NULL";

                        } else {
                            expression += "DEFAULT";
                        }

                        // just any other regular value
                    } else {
                        this.expressionMap.nativeParameters[paramName] = value;
                        expression += this.connection.driver.createParameter(paramName, parametersCount);
                        parametersCount++;
                    }

                    if (columnIndex === Object.keys(valueSet).length - 1) {
                        if (insertionIndex === valueSets.length - 1) {
                            expression += ")";
                        } else {
                            expression += "), ";
                        }
                    }
                    else {
                        expression += ", ";
                    }
                });
            });
            if (expression === "()")
                return "";
            return expression;
        }
    }

    /**
     * Gets array of values need to be inserted into the target table.
     */
    protected getValueSets(): ObjectLiteral[] {
        if (Array.isArray(this.expressionMap.valuesSet))
            return this.expressionMap.valuesSet;

        if (this.expressionMap.valuesSet instanceof Object)
            return [this.expressionMap.valuesSet];

        throw new InsertValuesMissingError();
    }
    protected createUpdateExpression() {
        const valuesSet = this.getValueSet();
        const metadata = this.expressionMap.mainAlias!.hasMetadata ? this.expressionMap.mainAlias!.metadata : undefined;

        // prepare columns and values to be updated
        const updateColumnAndValues: string[] = [];
        const updatedColumns: ColumnMetadata[] = [];
        const newParameters: ObjectLiteral = {};
        let parametersCount =   this.connection.driver instanceof MysqlDriver ||
        this.connection.driver instanceof AuroraDataApiDriver ||
        this.connection.driver instanceof OracleDriver ||
        this.connection.driver instanceof AbstractSqliteDriver ||
        this.connection.driver instanceof SapDriver
            ? 0 : Object.keys(this.expressionMap.nativeParameters).length;
        if (metadata) {
            EntityMetadata.createPropertyPath(metadata, valuesSet).forEach(propertyPath => {
                // todo: make this and other query builder to work with properly with tables without metadata
                const columns = metadata.findColumnsWithPropertyPath(propertyPath);

                if (columns.length <= 0) {
                    throw new EntityColumnNotFound(propertyPath);
                }

                columns.forEach(column => {
                    if (!column.isUpdate) { return; }
                    updatedColumns.push(column);

                    const paramName = "upd_" + column.databaseName;

                    //
                    let value = column.getEntityValue(valuesSet);
                    if (column.referencedColumn && value instanceof Object) {
                        value = column.referencedColumn.getEntityValue(value);
                    }
                    else if (!(value instanceof Function)) {
                        value = this.connection.driver.preparePersistentValue(value, column);
                    }

                    // todo: duplication zone
                    if (value instanceof Function) { // support for SQL expressions in update query
                        updateColumnAndValues.push(this.escape(column.databaseName) + " = " + value());
                    } else if (this.connection.driver instanceof SapDriver && value === null) {
                        updateColumnAndValues.push(this.escape(column.databaseName) + " = NULL");
                    } else {
                        if (this.connection.driver instanceof SqlServerDriver) {
                            value = this.connection.driver.parametrizeValue(column, value);

                            // } else if (value instanceof Array) {
                            //     value = new ArrayParameter(value);
                        }

                        if (this.connection.driver instanceof MysqlDriver ||
                            this.connection.driver instanceof AuroraDataApiDriver ||
                            this.connection.driver instanceof OracleDriver ||
                            this.connection.driver instanceof AbstractSqliteDriver ||
                            this.connection.driver instanceof SapDriver) {
                            newParameters[paramName] = value;
                        } else {
                            this.expressionMap.nativeParameters[paramName] = value;
                        }

                        let expression = null;
                        if ((this.connection.driver instanceof MysqlDriver || this.connection.driver instanceof AuroraDataApiDriver) && this.connection.driver.spatialTypes.indexOf(column.type) !== -1) {
                            const useLegacy = this.connection.driver.options.legacySpatialSupport;
                            const geomFromText = useLegacy ? "GeomFromText" : "ST_GeomFromText";
                            if (column.srid != null) {
                                expression = `${geomFromText}(${this.connection.driver.createParameter(paramName, parametersCount)}, ${column.srid})`;
                            } else {
                                expression = `${geomFromText}(${this.connection.driver.createParameter(paramName, parametersCount)})`;
                            }
                        } else if (this.connection.driver instanceof PostgresDriver && this.connection.driver.spatialTypes.indexOf(column.type) !== -1) {
                            if (column.srid != null) {
                                expression = `ST_SetSRID(ST_GeomFromGeoJSON(${this.connection.driver.createParameter(paramName, parametersCount)}), ${column.srid})::${column.type}`;
                            } else {
                                expression = `ST_GeomFromGeoJSON(${this.connection.driver.createParameter(paramName, parametersCount)})::${column.type}`;
                            }
                        } else if (this.connection.driver instanceof SqlServerDriver && this.connection.driver.spatialTypes.indexOf(column.type) !== -1) {
                            expression = column.type + "::STGeomFromText(" + this.connection.driver.createParameter(paramName, parametersCount) + ", " + (column.srid || "0") + ")";
                        } else {
                            expression = this.connection.driver.createParameter(paramName, parametersCount);
                        }
                        updateColumnAndValues.push(this.escape(column.databaseName) + " = " + expression);
                        parametersCount++;
                    }
                });
            });

            if (metadata.versionColumn && updatedColumns.indexOf(metadata.versionColumn) === -1)
                updateColumnAndValues.push(this.escape(metadata.versionColumn.databaseName) + " = " + this.escape(metadata.versionColumn.databaseName) + " + 1");
            if (metadata.updateDateColumn && updatedColumns.indexOf(metadata.updateDateColumn) === -1)
                updateColumnAndValues.push(this.escape(metadata.updateDateColumn.databaseName) + " = CURRENT_TIMESTAMP"); // todo: fix issue with CURRENT_TIMESTAMP(6) being used, can "DEFAULT" be used?!

        } else {
            Object.keys(valuesSet).map(key => {
                let value = valuesSet[key];

                // todo: duplication zone
                if (value instanceof Function) { // support for SQL expressions in update query
                    updateColumnAndValues.push(this.escape(key) + " = " + value());
                } else if (this.connection.driver instanceof SapDriver && value === null) {
                    updateColumnAndValues.push(this.escape(key) + " = NULL");
                } else {

                    // we need to store array values in a special class to make sure parameter replacement will work correctly
                    // if (value instanceof Array)
                    //     value = new ArrayParameter(value);

                    if (this.connection.driver instanceof MysqlDriver ||
                        this.connection.driver instanceof AuroraDataApiDriver ||
                        this.connection.driver instanceof OracleDriver ||
                        this.connection.driver instanceof AbstractSqliteDriver ||
                        this.connection.driver instanceof SapDriver) {
                        newParameters[key] = value;
                    } else {
                        this.expressionMap.nativeParameters[key] = value;
                    }

                    updateColumnAndValues.push(this.escape(key) + " = " + this.connection.driver.createParameter(key, parametersCount));
                    parametersCount++;
                }
            });
        }

        if (updateColumnAndValues.length <= 0) {
            throw new UpdateValuesMissingError();
        }

        // we re-write parameters this way because we want our "UPDATE ... SET" parameters to be first in the list of "nativeParameters"
        // because some drivers like mysql depend on order of parameters
        if (this.connection.driver instanceof MysqlDriver ||
            this.connection.driver instanceof AuroraDataApiDriver ||
            this.connection.driver instanceof OracleDriver ||
            this.connection.driver instanceof AbstractSqliteDriver ||
            this.connection.driver instanceof SapDriver) {
            this.expressionMap.nativeParameters = Object.assign(newParameters, this.expressionMap.nativeParameters);
        }

        // get a table name and all column database names
        const whereExpression = this.createWhereExpression();
        const returningExpression = this.createReturningExpression();

        // generate and return sql update query
        if (returningExpression && (this.connection.driver instanceof PostgresDriver || this.connection.driver instanceof OracleDriver || this.connection.driver instanceof CockroachDriver)) {
            return `UPDATE ${this.getTableName(this.getMainTableName())} SET ${updateColumnAndValues.join(", ")}${whereExpression} RETURNING ${returningExpression}`;

        } else if (returningExpression && this.connection.driver instanceof SqlServerDriver) {
            return `UPDATE ${this.getTableName(this.getMainTableName())} SET ${updateColumnAndValues.join(", ")} OUTPUT ${returningExpression}${whereExpression}`;

        } else {
            return `UPDATE ${this.getTableName(this.getMainTableName())} SET ${updateColumnAndValues.join(", ")}${whereExpression}`; // todo: how do we replace aliases in where to nothing?
        }
    }

    /**
     * Creates "LIMIT" parts of SQL query.
     */
    protected createLimitExpression(): string {
        let limit: number|undefined = this.expressionMap.limit;

        if (limit) {
            if (this.connection.driver instanceof MysqlDriver || this.connection.driver instanceof AuroraDataApiDriver) {
                return " LIMIT " + limit;
            } else {
                throw new LimitOnUpdateNotSupportedError();
            }
        }

        return "";
    }

    /**
     * Gets array of values need to be inserted into the target table.
     */
    protected getValueSet(): ObjectLiteral {
        if (this.expressionMap.valuesSet instanceof Object)
            return this.expressionMap.valuesSet;

        throw new UpdateValuesMissingError();
    }

    /**
     * Checks if column is an auto-generated primary key, but the current insertion specifies a value for it.
     *
     * @param column
     */
    protected isOverridingAutoIncrementBehavior(column: ColumnMetadata): boolean {
        return column.isPrimary
            && column.isGenerated
            && column.generationStrategy === "increment"
            && this.getValueSets().some((valueSet) =>
                column.getEntityValue(valueSet) !== undefined
                && column.getEntityValue(valueSet) !== null
            );
    }

    // -------------------------------------------------------------------------
    // Protected Methods
    // -------------------------------------------------------------------------

    /**
     * Creates UPDATE express used to perform insert query.
     */
    protected createSoftDeleteExpression() {
        const metadata = this.expressionMap.mainAlias!.hasMetadata ? this.expressionMap.mainAlias!.metadata : undefined;
        if (!metadata)
            throw new Error(`Cannot get entity metadata for the given alias "${this.expressionMap.mainAlias}"`);
        if (!metadata.deleteDateColumn) {
            throw new MissingDeleteDateColumnError(metadata);
        }

        // prepare columns and values to be updated
        const updateColumnAndValues: string[] = [];
        const newParameters: ObjectLiteral = {};

        switch (this.expressionMap.queryType) {
            case "soft-delete":
                updateColumnAndValues.push(this.escape(metadata.deleteDateColumn.databaseName) + " = CURRENT_TIMESTAMP");
                break;
            case "restore":
                updateColumnAndValues.push(this.escape(metadata.deleteDateColumn.databaseName) + " = NULL");
                break;
            default:
                throw new Error(`The queryType must be "soft-delete" or "restore"`);
        }
        if (metadata.versionColumn)
            updateColumnAndValues.push(this.escape(metadata.versionColumn.databaseName) + " = " + this.escape(metadata.versionColumn.databaseName) + " + 1");
        if (metadata.updateDateColumn)
            updateColumnAndValues.push(this.escape(metadata.updateDateColumn.databaseName) + " = CURRENT_TIMESTAMP"); // todo: fix issue with CURRENT_TIMESTAMP(6) being used, can "DEFAULT" be used?!

        if (updateColumnAndValues.length <= 0) {
            throw new UpdateValuesMissingError();
        }

        // we re-write parameters this way because we want our "UPDATE ... SET" parameters to be first in the list of "nativeParameters"
        // because some drivers like mysql depend on order of parameters
        if (this.connection.driver instanceof MysqlDriver ||
            this.connection.driver instanceof OracleDriver ||
            this.connection.driver instanceof AbstractSqliteDriver) {
            this.expressionMap.nativeParameters = Object.assign(newParameters, this.expressionMap.nativeParameters);
        }

        // get a table name and all column database names
        const whereExpression = this.createWhereExpression();
        const returningExpression = this.createReturningExpression();

        // generate and return sql update query
        if (returningExpression && (this.connection.driver instanceof PostgresDriver || this.connection.driver instanceof OracleDriver || this.connection.driver instanceof CockroachDriver)) {
            return `UPDATE ${this.getTableName(this.getMainTableName())} SET ${updateColumnAndValues.join(", ")}${whereExpression} RETURNING ${returningExpression}`;

        } else if (returningExpression && this.connection.driver instanceof SqlServerDriver) {
            return `UPDATE ${this.getTableName(this.getMainTableName())} SET ${updateColumnAndValues.join(", ")} OUTPUT ${returningExpression}${whereExpression}`;

        } else {
            return `UPDATE ${this.getTableName(this.getMainTableName())} SET ${updateColumnAndValues.join(", ")}${whereExpression}`; // todo: how do we replace aliases in where to nothing?
        }
    }

    private getSelectQuery() {
        let sql = this.createComment();
        sql += this.createSelectExpression();
        sql += this.createJoinExpression();
        sql += this.createWhereExpression();
        sql += this.createGroupByExpression();
        sql += this.createHavingExpression();
        sql += this.createOrderByExpression();
        sql += this.createLimitOffsetExpression();
        sql += this.createLockExpression();
        sql = sql.trim();
        if (this.expressionMap.subQuery)
            sql = "(" + sql + ")";
        return sql;
    }

    private getUpdateQuery() {
        let sql = this.createComment();
        sql += this.createUpdateExpression();
        sql += this.createOrderByExpression();
        sql += this.createLimitExpression();
        return sql.trim();
    }

    private getInsertQuery() {
        let sql = this.createComment();
        sql += this.createInsertExpression();
        return sql.trim();
    }

    private getRelationQuery() {
        return "";
    }

    private getSoftDeleteQuery() {
        let sql = this.createSoftDeleteExpression();
        sql += this.createOrderByExpression();
        sql += this.createLimitExpression();
        return sql.trim();
    }

    private getRestoreQuery() {
        let sql = this.createSoftDeleteExpression();
        sql += this.createOrderByExpression();
        sql += this.createLimitExpression();
        return sql.trim();
    }
}
