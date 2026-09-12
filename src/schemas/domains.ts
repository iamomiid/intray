import { z } from "zod";
import { domainName, pageArgs } from "./common";

export const addDomainBody = z.object({ domain: domainName });

export const addDomainInput = addDomainBody;

export const listDomainsQuery = z.object(pageArgs);

export const listDomainsInput = listDomainsQuery;

export const domainParams = z.object({ domain: domainName });

export const domainInput = domainParams;
