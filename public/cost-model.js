export function compareCosts({requests,replicaHours,hourlyUSD,ttsCharacters,ttsUSDPerMillion=16,sonicUSDPerRequest}){
 for(const value of [requests,replicaHours,hourlyUSD,ttsCharacters,ttsUSDPerMillion,sonicUSDPerRequest])if(!Number.isFinite(value)||value<0)throw Error('Costs and quantities must be finite and non-negative');
 const fixedUSD=replicaHours*hourlyUSD,variableUSDPerRequest=ttsCharacters*ttsUSDPerMillion/1e6;
 return {fixedUSD,variableUSDPerRequest,openUSD:fixedUSD+requests*variableUSDPerRequest,sonicUSD:requests*sonicUSDPerRequest,breakEvenRequests:sonicUSDPerRequest>variableUSDPerRequest?fixedUSD/(sonicUSDPerRequest-variableUSDPerRequest):null};
}
