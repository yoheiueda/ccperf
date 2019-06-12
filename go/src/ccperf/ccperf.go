package main

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	_ "net/http/pprof"
	"os"
	"strconv"
	"strings"

	"github.com/hyperledger/fabric/core/chaincode/shim"
	pb "github.com/hyperledger/fabric/protos/peer"
)

type log struct{}

func (l log) Debug(v ...interface{})                 {}
func (l log) Debugf(format string, v ...interface{}) {}
func (l log) Info(v ...interface{})                  { fmt.Println(v...) }
func (l log) Infof(format string, v ...interface{})  { fmt.Printf(format, v...) }
func (l log) Error(v ...interface{})                 { fmt.Fprintln(os.Stderr, v...) }
func (l log) Errorf(format string, v ...interface{}) { fmt.Fprintf(os.Stderr, format, v...) }

var logger log

// CCPerf
type CCPerf struct {
	buffers map[int][]byte
}

func NewCCPerf() *CCPerf {
	ccperf := new(CCPerf)
	ccperf.buffers = make(map[int][]byte)

	for size := 1; size <= 65536; size *= 2 {
		ccperf.buffers[size] = make([]byte, size)
		for i := 0; i < len(ccperf.buffers[size]); i++ {
			ccperf.buffers[size][i] = byte(23 * i)
		}
	}
	return ccperf
}

func (ccperf *CCPerf) Init(stub shim.ChaincodeStubInterface) pb.Response {

	_, _ = stub.GetFunctionAndParameters()

	return shim.Success(nil)
}

func (ccperf *CCPerf) Invoke(stub shim.ChaincodeStubInterface) pb.Response {
	logger.Debug("CCPerf.Invoke is called")
	defer logger.Debug("CCPerf.Invoke returns")

	function, args := stub.GetFunctionAndParameters()

	logger.Debugf("function name: %s", function)

	switch function {
	case "populate":
		return ccperf.runPopulate(stub, args)
	case "empty":
		return ccperf.runEmpty(stub, args)
	case "putstate":
		return ccperf.runPutState(stub, args)
	case "getstate":
		return ccperf.runGetState(stub, args)
	case "rangequery":
		return ccperf.runRangeQuery(stub, args)
	case "rangequery_update":
		return ccperf.runRangeQueryUpdate(stub, args)
	case "mix":
		return ccperf.runMix(stub, args)
	case "json":
		return ccperf.runJSON(stub, args)
	case "contended":
		return ccperf.runContended(stub, args)
	case "invoke_chaincode":
		return ccperf.runInvokeChaincode(stub, args)
	case "hash":
		return ccperf.runHash(stub, args)
	case "floating_point":
		return ccperf.runFloatingPoint(stub, args)
	}

	msg := fmt.Sprintf("Unknown function name: %s", function)
	logger.Error(msg)
	return shim.Error(msg)
}

func getDatakey(i int) string {
	return fmt.Sprintf("DATAKEY_%010d", i)
}

func (ccperf *CCPerf) runPopulate(stub shim.ChaincodeStubInterface, args []string) pb.Response {
	if len(args) != 3 {
		msg := fmt.Sprintf("Incorrect number of arguments. Expecting 3, received %d", len(args))
		logger.Error(msg)
		return shim.Error(msg)
	}

	start, err := strconv.Atoi(args[0])
	if err != nil {
		logger.Error(err.Error())
		return shim.Error(err.Error())
	}

	num, err := strconv.Atoi(args[1])
	if err != nil {
		logger.Error(err.Error())
		return shim.Error(err.Error())
	}

	size, err := strconv.Atoi(args[2])
	if err != nil {
		logger.Error(err.Error())
		return shim.Error(err.Error())
	}

	buffer, ok := ccperf.buffers[size]
	if !ok {
		msg := fmt.Sprintf("Incorrect buffer size specified.　received %d", size)
		logger.Error(msg)
		return shim.Error(msg)
	}

	maxKey := getDatakey(num - 1)
	val, err := stub.GetState(maxKey)
	if err != nil {
		logger.Error(err.Error())
		return shim.Error(err.Error())
	}
	if val != nil && len(val) == size {
		logger.Infof("Already populated. num=%d, size=%d\n", num, size)
		return shim.Success(nil)
	}

	for i := 0; i < num; i++ {
		key := getDatakey(start + i)
		err = stub.PutState(key, buffer)
		if err != nil {
			logger.Error(err.Error())
			return shim.Error(err.Error())
		}
		logger.Debugf("Data key=%s stored\n", key)
	}

	logger.Infof("Populated. num=%d, size=%d\n", num, size)

	return shim.Success(nil)
}

func (ccperf *CCPerf) runPutState(stub shim.ChaincodeStubInterface, args []string) pb.Response {
	if len(args) != 3 {
		msg := fmt.Sprintf("Incorrect number of arguments. Expecting 3, received %d", len(args))
		logger.Error(msg)
		return shim.Error(msg)
	}

	num, err := strconv.Atoi(args[0])
	if err != nil {
		logger.Error(err.Error())
		return shim.Error(err.Error())
	}

	size, err := strconv.Atoi(args[1])
	if err != nil {
		logger.Error(err.Error())
		return shim.Error(err.Error())
	}

	key := args[2]

	buffer, ok := ccperf.buffers[size]
	if !ok {
		msg := fmt.Sprintf("Incorrect buffer size specified.　received %d", size)
		logger.Error(msg)
		return shim.Error(msg)
	}

	for i := 0; i < num; i++ {
		err = stub.PutState(key+"_"+strconv.Itoa(i), buffer)
		if err != nil {
			logger.Error(err.Error())
			return shim.Error(err.Error())
		}
	}

	return shim.Success(nil)
}

func (ccperf *CCPerf) runGetState(stub shim.ChaincodeStubInterface, args []string) pb.Response {
	if len(args) != 3 {
		msg := fmt.Sprintf("Incorrect number of arguments. Expecting 3, received %d", len(args))
		logger.Error(msg)
		return shim.Error(msg)
	}

	num, err := strconv.Atoi(args[0])
	if err != nil {
		logger.Error(err.Error())
		return shim.Error(err.Error())
	}

	max, err := strconv.Atoi(args[1])
	if err != nil {
		logger.Error(err.Error())
		return shim.Error(err.Error())
	}

	base := 0
	flag := false
	s := strings.Split(args[2], "_")
	if len(s) == 6 {
		x1, err1 := strconv.Atoi(s[3])
		x2, err2 := strconv.Atoi(s[4])
		x3, err3 := strconv.Atoi(s[5])
		if err1 == nil && err2 == nil && err3 == nil {
			base = 1000151*x1 + 100207*x2 + 3001*x3
			flag = true
		}
	}
	if !flag {
		msg := fmt.Sprintf("Invalid key format: %s", args[2])
		logger.Error(msg)
		return shim.Error(msg)
	}

	for i := 0; i < num; i++ {
		key := getDatakey((base + 401*i) % max)
		logger.Debugf("GetState(%s)", key)
		val, err := stub.GetState(key)
		if err != nil {
			logger.Error(err.Error())
			return shim.Error(err.Error())
		}
		if val == nil {
			msg := fmt.Sprintf("GetState failed for key %s", key)
			logger.Error(msg)
			return shim.Error(msg)
		}
	}

	return shim.Success(nil)
}

func (ccperf *CCPerf) runRangeQuery(stub shim.ChaincodeStubInterface, args []string) pb.Response {
	if len(args) != 2 {
		msg := fmt.Sprintf("Incorrect number of arguments. Expecting 2, received %d", len(args))
		logger.Error(msg)
		return shim.Error(msg)
	}

	num, err := strconv.Atoi(args[0])
	if err != nil {
		logger.Error(err.Error())
		return shim.Error(err.Error())
	}

	max, err := strconv.Atoi(args[1])
	if err != nil {
		logger.Error(err.Error())
		return shim.Error(err.Error())
	}

	for i := 0; i < num; i++ {
		minKey := getDatakey(0)
		maxKey := getDatakey(max)
		logger.Debugf("GetStateByRange(\"%s\", \"%s\")\n", minKey, maxKey)
		iter, err := stub.GetStateByRange(minKey, maxKey)
		if err != nil {
			logger.Error(err.Error())
			return shim.Error(err.Error())
		}

		count := 0
		for iter.HasNext() {
			kv, err := iter.Next()
			if err != nil {
				logger.Error(err.Error())
				return shim.Error(err.Error())
			}
			key := kv.Key
			value := kv.Value
			logger.Debugf("key=%s, value=%s\n", key, value)
			count++
		}
		logger.Debugf("query result count=%d\n", count)
	}

	return shim.Success(nil)
}

func (ccperf *CCPerf) runRangeQueryUpdate(stub shim.ChaincodeStubInterface, args []string) pb.Response {
	if len(args) != 4 {
		msg := fmt.Sprintf("Incorrect number of arguments. Expecting 4, received %d", len(args))
		logger.Error(msg)
		return shim.Error(msg)
	}

	num, err := strconv.Atoi(args[0])
	if err != nil {
		logger.Error(err.Error())
		return shim.Error(err.Error())
	}

	size, err := strconv.Atoi(args[1])
	if err != nil {
		logger.Error(err.Error())
		return shim.Error(err.Error())
	}

	key := args[2]

	max, err := strconv.Atoi(args[3])
	if err != nil {
		logger.Error(err.Error())
		return shim.Error(err.Error())
	}

	minKey := getDatakey(0)
	maxKey := getDatakey(max)
	logger.Debugf("GetStateByRange(\"%s\", \"%s\")\n", minKey, maxKey)
	iter, err := stub.GetStateByRange(minKey, maxKey)
	if err != nil {
		logger.Error(err.Error())
		return shim.Error(err.Error())
	}

	count := 0
	for iter.HasNext() {
		kv, err := iter.Next()
		if err != nil {
			logger.Error(err.Error())
			return shim.Error(err.Error())
		}
		key := kv.Key
		value := kv.Value
		logger.Debugf("key=%s, value=%s\n", key, value)
		count++
	}
	logger.Debugf("query result count=%d\n", count)

	buffer, ok := ccperf.buffers[size]
	if !ok {
		msg := fmt.Sprintf("Incorrect buffer size specified.　received %d", size)
		logger.Error(msg)
		return shim.Error(msg)
	}

	for i := 0; i < num; i++ {
		err = stub.PutState(key+"_"+strconv.Itoa(i), buffer)
		if err != nil {
			logger.Error(err.Error())
			return shim.Error(err.Error())
		}
	}

	return shim.Success(nil)
}

func (ccperf *CCPerf) runMix(stub shim.ChaincodeStubInterface, args []string) pb.Response {
	if len(args) != 5 {
		msg := fmt.Sprintf("Incorrect number of arguments. Expecting 5, received %d", len(args))
		logger.Error(msg)
		return shim.Error(msg)
	}

	getArgs := []string{args[0], args[4], args[3]}
	res := ccperf.runGetState(stub, getArgs)
	if res.GetStatus() != 200 {
		return res
	}

	putArgs := []string{args[1], args[2], args[3]}
	return ccperf.runPutState(stub, putArgs)
}

type jsonDataType struct {
	Data1  string  `json:"data1"`
	Data2  string  `json:"data2"`
	Data3  string  `json:"data3"`
	Data4  string  `json:"data4"`
	Data5  float64 `json:"data5"`
	Data6  float64 `json:"data6"`
	Data7  float64 `json:"data7"`
	Data8  int     `json:"data8"`
	Data9  int     `json:"data9"`
	Data10 int     `json:"data10"`
}

func (ccperf *CCPerf) runJSON(stub shim.ChaincodeStubInterface, args []string) pb.Response {
	if len(args) != 5 {
		msg := fmt.Sprintf("Incorrect number of arguments. Expecting 5, received %d", len(args))
		logger.Error(msg)
		return shim.Error(msg)
	}

	jsonData := jsonDataType{
		Data1:  "123456",
		Data2:  "abcdefg",
		Data3:  "XYZ",
		Data4:  "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
		Data5:  1.23,
		Data6:  9.99,
		Data7:  777.0,
		Data8:  123,
		Data9:  999,
		Data10: -123,
	}

	num, err := strconv.Atoi(args[0])
	if err != nil {
		logger.Error(err.Error())
		return shim.Error(err.Error())
	}
	for i := 0; i < num; i++ {
		bytes, err := json.Marshal(jsonData)
		if err != nil {
			msg := fmt.Sprintf("Failed to marshall JSON data")
			logger.Error(msg)
			return shim.Error(msg)
		}

		logger.Debugf("json: %s", string(bytes))

		var out jsonDataType
		err = json.Unmarshal(bytes, &out)
		if err != nil {
			msg := fmt.Sprintf("Failed to unmarshall JSON data")
			logger.Error(msg)
			return shim.Error(msg)
		}
	}

	getArgs := []string{args[0], args[4], args[3]}
	res := ccperf.runGetState(stub, getArgs)
	if res.GetStatus() != 200 {
		return res
	}

	putArgs := []string{args[1], args[2], args[3]}
	return ccperf.runPutState(stub, putArgs)
}

func (ccperf *CCPerf) runContended(stub shim.ChaincodeStubInterface, args []string) pb.Response {
	for _, arg := range args {
		i, err := strconv.Atoi(arg)
		if err != nil {
			logger.Error(err.Error())
			return shim.Error(err.Error())
		}
		key := getDatakey(i)
		logger.Debugf("GetState(%s)\n", key)
		val, err := stub.GetState(key)
		if err != nil {
			logger.Error(err.Error())
			return shim.Error(err.Error())
		}
		if val == nil {
			msg := fmt.Sprintf("GetState failed for key %s", key)
			logger.Error(msg)
			return shim.Error(msg)
		}
		err = stub.PutState(key, val)
		if err != nil {
			logger.Error(err.Error())
			return shim.Error(err.Error())
		}
	}
	return shim.Success(nil)
}

func (ccperf *CCPerf) runInvokeChaincode(stub shim.ChaincodeStubInterface, args []string) pb.Response {
	if len(args) < 2 {
		msg := fmt.Sprintf("Incorrect number of arguments. Expecting more than 1, received %d", len(args))
		logger.Error(msg)
		return shim.Error(msg)
	}

	num, err := strconv.Atoi(args[0])
	if err != nil {
		logger.Error(err.Error())
		return shim.Error(err.Error())
	}

	chaincodeName := args[1]
	var chaincodeArgs [][]byte
	for _, arg := range args[2:] {
		chaincodeArgs = append(chaincodeArgs, []byte(arg))
	}

	for i := 0; i < num; i++ {
		res := stub.InvokeChaincode(chaincodeName, chaincodeArgs, "")
		if res.GetStatus() != 200 {
			msg := fmt.Sprintf("Failed to InvokeChaincode %s: [%d]%s", chaincodeName, res.GetStatus(), res.GetMessage())
			logger.Error(msg)
			return shim.Error(msg)
		}
	}

	return shim.Success(nil)
}

func (ccperf *CCPerf) runHash(stub shim.ChaincodeStubInterface, args []string) pb.Response {
	if len(args) != 2 {
		msg := fmt.Sprintf("Incorrect number of arguments. Expecting 2, received %d", len(args))
		logger.Error(msg)
		return shim.Error(msg)
	}

	num, err := strconv.Atoi(args[0])
	if err != nil {
		logger.Error(err.Error())
		return shim.Error(err.Error())
	}

	key := args[1]
	hash := []byte(key)

	for i := 0; i < num; i++ {
		h := sha256.Sum256(hash)
		copy(hash, h[:])
	}

	err = stub.PutState(key, hash)
	if err != nil {
		logger.Error(err.Error())
		return shim.Error(err.Error())
	}

	return shim.Success(nil)
}

func (ccperf *CCPerf) runEmpty(stub shim.ChaincodeStubInterface, args []string) pb.Response {
	if len(args) != 0 {
		msg := fmt.Sprintf("Incorrect number of arguments. Expecting 0, received %d", len(args))
		logger.Error(msg)
		return shim.Error(msg)
	}

	return shim.Success(nil)
}

func (ccperf *CCPerf) runFloatingPoint(stub shim.ChaincodeStubInterface, args []string) pb.Response {
	if len(args) != 1 {
		msg := fmt.Sprintf("Incorrect number of arguments. Expecting 1, received %d", len(args))
		logger.Error(msg)
		return shim.Error(msg)
	}

	num, err := strconv.Atoi(args[0])
	if err != nil {
		logger.Error(err.Error())
		return shim.Error(err.Error())
	}

	x := 1.0

	for i := 0; i < num; i++ {
		for j := 0; j < 10000000; i++ {
			x = math.Sin(x)
		}
	}

	return shim.Success([]byte(string(int(x))))
}

func (ccperf *CCPerf) runAllocation(stub shim.ChaincodeStubInterface, args []string) pb.Response {
	if len(args) != 2 {
		msg := fmt.Sprintf("Incorrect number of arguments. Expecting 2, received %d", len(args))
		logger.Error(msg)
		return shim.Error(msg)
	}

	num, err := strconv.Atoi(args[0])
	if err != nil {
		logger.Error(err.Error())
		return shim.Error(err.Error())
	}

	size, err := strconv.Atoi(args[1])
	if err != nil {
		logger.Error(err.Error())
		return shim.Error(err.Error())
	}

	var x, y []byte
	count := 0
	for i := 0; i < num; i++ {
		y = x
		x = make([]byte, size)
		x[size-1] = 1
		count += len(x) + len(y)
	}

	return shim.Success([]byte(string(count)))
}

func main() {
	go http.ListenAndServe("0.0.0.0:6060", nil)

	//logger.SetLevel(shim.LogInfo)
	logger.Info("CCPerf chaincode started")
	defer logger.Info("CCPerf chaincode finished")

	ccperf := NewCCPerf()

	err := shim.Start(ccperf)
	if err != nil {
		logger.Errorf("Failed to start chaincode: %s", err)
	}
}
